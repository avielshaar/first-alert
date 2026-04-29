/**
 * Message Processing and Event Tracking Module (Hybrid Sync)
 */

const { log } = require("../logger");
const { classifyMessage, checkForNewInfo } = require("./classifier");
const { CONTEXT_WINDOW_MS, MIN_CHANNELS_TO_ACT } = require("../config");

const activeEvents = {};
let lastPublished = null;

function setLastPublished(source, target, estimated_time) {
    if (!source && !target && !estimated_time) {
        lastPublished = null;
        return;
    }
    lastPublished = { source, target, estimated_time, publishedAt: Date.now() };
}

function getLastPublished() { return lastPublished; }
function getActiveEvents()  { return activeEvents; }

function mergeTargets(existing, incoming) {
    const arr1 = (existing || "").split(",").map(s => s.trim()).filter(Boolean);
    const arr2 = (incoming || "").split(",").map(s => s.trim()).filter(Boolean);
    let merged = [...new Set([...arr1, ...arr2])];
    merged = merged.filter(item => {
        return !merged.some(other => other !== item && other.includes(item));
    });
    return merged.sort().join(", ");
}

function pickBestEvent(candidates) {
    const scored = candidates.map(key => {
        const e = activeEvents[key];
        const totalInfo = (e.source ? 1 : 0) + (e.target ? 1 : 0) + (e.estimated_time ? 1 : 0);
        return { key, totalInfo, channelCount: e.channels.size };
    });
    scored.sort((a, b) => b.totalInfo - a.totalInfo || b.channelCount - a.channelCount);
    return scored[0].key;
}

async function processMessage(channelId, messageText, callbacks) {
    const now = Date.now();

    const classification = await classifyMessage(channelId, messageText, lastPublished);
    log(`[Hybrid-AI] Category: ${classification.category} | Reasoning: ${classification.reasoning}`);

    if (classification.category === "UPDATE_TO_LAST" && lastPublished) {
        const isSourceNew = classification.source && lastPublished.source && classification.source !== lastPublished.source;
        if (!isSourceNew) {
            const mergedTarget = mergeTargets(lastPublished.target, classification.target);
            const hasNewTarget = mergedTarget !== lastPublished.target;
            const hasNewTime   = classification.estimated_time && classification.estimated_time !== lastPublished.estimated_time;

            if (hasNewTarget || hasNewTime) {
                log(`[Update] 📝 Single-channel update — publishing.`);
                const updateType = hasNewTarget && hasNewTime ? "target+time" : hasNewTarget ? "target" : "time";
                await callbacks.update(
                    { source: lastPublished.source, target: mergedTarget, estimated_time: classification.estimated_time || lastPublished.estimated_time },
                    lastPublished,
                    updateType,
                );
                return;
            }
        }
    }

    if (classification.category !== "LAUNCH_REPORT") {
        log(`[Filter] ❌ IRRELEVANT — ignoring.`);
        return;
    }

    const eventKey = classification.event_key || "->";
    log(`[Filter] ✅ Launch report! Event: "${eventKey}" from channel ${channelId}`);

    const [srcPart, tgtPart] = eventKey.split("->");
    const hasSource = srcPart && srcPart.trim() !== "";
    const hasTarget = tgtPart && tgtPart.trim() !== "";

    // התיקון הקריטי: אם יש לנו מקור מזהה (איראן), אנחנו לא תופסים את המפתח הריק "->" !
    const eventKeysToTrack = [];
    if (hasSource && hasTarget) {
        eventKeysToTrack.push(`${srcPart}->${tgtPart}`);
        eventKeysToTrack.push(`${srcPart}->`);
        eventKeysToTrack.push(`->${tgtPart}`);
    } else if (hasSource) {
        eventKeysToTrack.push(`${srcPart}->`);
    } else if (hasTarget) {
        eventKeysToTrack.push(`->${tgtPart}`);
    } else {
        eventKeysToTrack.push(`->`); // רק הודעה בלי שום מידע תקבל את המפתח הזה
    }

    for (const key of Object.keys(activeEvents)) {
        if (now - activeEvents[key].firstSeen > CONTEXT_WINDOW_MS) {
            delete activeEvents[key];
        }
    }

    for (const currentKey of eventKeysToTrack) {
        if (!activeEvents[currentKey]) {
            activeEvents[currentKey] = {
                channels:       new Set(),
                messages:       [],
                source:         classification.source         || "",
                target:         classification.target         || "",
                estimated_time: classification.estimated_time || "",
                firstSeen:      now,
            };
        }
        const event = activeEvents[currentKey];
        event.channels.add(channelId);
        event.messages.push({ channel: channelId, text: messageText, time: now });

        if (classification.source && !event.source) event.source = classification.source;
        if (classification.target) event.target = mergeTargets(event.target, classification.target);
        if (classification.estimated_time && !event.estimated_time) event.estimated_time = classification.estimated_time;
    }

    const readyForPublish = [];
    for (const checkKey of eventKeysToTrack) {
        const event = activeEvents[checkKey];
        log(`[Events] 📊 "${checkKey}": ${event.channels.size}/${MIN_CHANNELS_TO_ACT} channels confirmed.`);
        if (event.channels.size >= MIN_CHANNELS_TO_ACT) readyForPublish.push(checkKey);
    }

    if (readyForPublish.length === 0) {
        log(`[Filter] ⏸  Waiting for corroboration...`);
        return;
    }

    const keyToPublish = readyForPublish.length === 1 ? readyForPublish[0] : pickBestEvent(readyForPublish);
    const finalEvent = activeEvents[keyToPublish];

    const isDifferentArena = lastPublished && finalEvent.source && lastPublished.source && finalEvent.source !== lastPublished.source;

    if (!lastPublished || isDifferentArena) {
        log(`[Hybrid] 🚨 First publish for arena — "${keyToPublish}"`);
        await callbacks.alert(finalEvent.source, finalEvent.target, finalEvent.estimated_time);
        delete activeEvents[keyToPublish]; 
        return;
    }

    const newInfoCheck = await checkForNewInfo(finalEvent.messages, lastPublished);
    
    if (newInfoCheck.has_new_info) {
        const finalMergedTarget = mergeTargets(lastPublished.target, newInfoCheck.target);
        const finalTime = newInfoCheck.estimated_time || lastPublished.estimated_time;
        const finalSource = newInfoCheck.source || lastPublished.source;

        const isTargetNew = finalMergedTarget !== (lastPublished.target || "");
        const isTimeNew = finalTime && finalTime !== lastPublished.estimated_time;

        if (!isTargetNew && !isTimeNew) {
             log(`[Dedup] 🔁 Programmatically nothing changed — skipping.`);
             delete activeEvents[keyToPublish];
             return;
        }

        log(`[Hybrid] 🚨 New info confirmed: ${newInfoCheck.reasoning}`);
        await callbacks.update(
            { source: finalSource, target: finalMergedTarget, estimated_time: finalTime },
            lastPublished,
            isTargetNew && isTimeNew ? "target+time" : isTargetNew ? "target" : "time"
        );
    } else {
        log(`[Dedup] 🔁 Skipped — ${newInfoCheck.reasoning}`);
    }
    
    delete activeEvents[keyToPublish];
}

module.exports = { processMessage, setLastPublished, getLastPublished, getActiveEvents };