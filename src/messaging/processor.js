/**
 * Message Processing and Event Tracking Module.
 *
 * Each incident is represented by one event object. Correlation is performed against
 * event attributes instead of storing the same incident under several partial keys.
 * A message is considered processed only after classification and any required publish
 * operation complete successfully; returning false asks the Telegram poller to retry it.
 */

const { log } = require("../utils/logger");
const { classifyMessage, checkForNewInfo } = require("./classifier");
const {
    CONTEXT_WINDOW_MS,
    LAST_PUBLISHED_DEDUP_WINDOW_MS,
    MIN_CHANNELS_TO_ACT,
} = require("../config");

const stateFile = process.env.FIRST_ALERT_STATE_FILE || "./data/processor-state.json";
const activeEvents = {};
let lastPublished = null;
let nextEventId = 1;

function persistProcessorState() {
    const payload = {
        version: 1,
        nextEventId,
        lastPublished,
        activeEvents: Object.fromEntries(Object.entries(activeEvents).map(([id, event]) => [id, {
            ...event,
            channels: [...event.channels],
            messageKeys: [...event.messageKeys],
        }])),
    };
    const tempFile = `${stateFile}.tmp`;
    try {
        require("fs").mkdirSync(require("path").dirname(tempFile), { recursive: true });
        require("fs").writeFileSync(tempFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
        try { require("fs").chmodSync(tempFile, 0o600); } catch (_) { /* best effort on platforms without POSIX modes */ }
        require("fs").renameSync(tempFile, stateFile);
        return true;
    } catch (error) {
        log(`[State] Could not persist processor state to ${stateFile}: ${error.message || error}`);
        try { require("fs").unlinkSync(tempFile); } catch (_) { /* ignore temp cleanup failure */ }
        return false;
    }
}

function loadProcessorState() {
    const fs = require("fs");
    try {
        if (!fs.existsSync(stateFile)) return;
        const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            parsed.version !== 1 ||
            !parsed.activeEvents ||
            typeof parsed.activeEvents !== "object" ||
            Array.isArray(parsed.activeEvents)
        ) {
            throw new Error("unsupported or malformed processor state file");
        }
        if (!Number.isSafeInteger(parsed.nextEventId) || parsed.nextEventId < 1) {
            throw new Error("invalid nextEventId in processor state file");
        }
        if (parsed.lastPublished !== null && parsed.lastPublished !== undefined &&
            (typeof parsed.lastPublished !== "object" || Array.isArray(parsed.lastPublished))) {
            throw new Error("invalid lastPublished value in processor state file");
        }

        const loadedEvents = {};
        let highestEventNumber = 0;
        for (const [id, raw] of Object.entries(parsed.activeEvents)) {
            const keyMatch = /^event-(\\d+)$/.exec(id);
            if (!keyMatch || !raw || typeof raw !== "object" || Array.isArray(raw)) {
                throw new Error("invalid pending event entry: " + id);
            }
            if (!["LAUNCH_REPORT", "UPDATE_TO_LAST"].includes(raw.kind)) {
                throw new Error("invalid pending event kind for " + id);
            }
            if (raw.id !== id) {
                throw new Error("pending event ID does not match its state key: " + id);
            }
            if (!Array.isArray(raw.channels) || !Array.isArray(raw.messages) ||
                !Array.isArray(raw.messageKeys)) {
                throw new Error("invalid pending event collections for " + id);
            }
            if (!Number.isFinite(raw.firstSeen) || !Number.isFinite(raw.lastSeen) ||
                typeof raw.source !== "string" || typeof raw.target !== "string" ||
                typeof raw.estimated_time !== "string") {
                throw new Error("invalid pending event fields for " + id);
            }

            highestEventNumber = Math.max(highestEventNumber, Number(keyMatch[1]));
            loadedEvents[id] = {
                ...raw,
                channels: new Set(raw.channels.map(String)),
                messages: raw.messages,
                messageKeys: new Set(raw.messageKeys),
            };
        }
        if (parsed.nextEventId <= highestEventNumber) {
            throw new Error("nextEventId would collide with a pending event");
        }

        Object.assign(activeEvents, loadedEvents);
        lastPublished = parsed.lastPublished || null;
        nextEventId = parsed.nextEventId;
        log(`[State] Restored ${Object.keys(activeEvents).length} pending event(s) from disk.`);
    } catch (error) {
        log(`[State] Could not load processor state from ${stateFile}: ${error.message || error}`);
        throw new Error(
            "Processor state is invalid or unreadable. Refusing to start to avoid losing pending incident evidence. " +
            "Back up and repair the state file at " + stateFile + ", then restart.",
            { cause: error }
        );
    }
}

loadProcessorState();
expireStaleLastPublished(Date.now());

function setLastPublished(source, target, estimated_time) {
    const previous = lastPublished;
    if (!source && !target && !estimated_time) {
        lastPublished = null;
    } else {
        lastPublished = {
            source: source || "",
            target: target || "",
            estimated_time: estimated_time || "",
            publishedAt: Date.now(),
        };
    }
    if (!persistProcessorState()) {
        lastPublished = previous;
        return false;
    }
    return true;
}

function getLastPublished() { return lastPublished; }
function getActiveEvents() { return activeEvents; }

// Expire the publication baseline, not the two-minute event-correlation window.
// A missing/invalid timestamp is treated as stale so legacy/corrupt state cannot suppress alerts forever.
function expireStaleLastPublished(now = Date.now()) {
    if (!lastPublished) return false;

    const rawPublishedAt = lastPublished.publishedAt;
    const publishedAt = Number(rawPublishedAt);
    const hasValidTimestamp =
        rawPublishedAt !== undefined &&
        rawPublishedAt !== null &&
        Number.isFinite(publishedAt) &&
        publishedAt > 0 &&
        publishedAt <= now + 60_000;
    const ageMs = now - publishedAt;

    if (hasValidTimestamp && ageMs < LAST_PUBLISHED_DEDUP_WINDOW_MS) return false;

    const reason = !hasValidTimestamp
        ? "missing or invalid publication timestamp"
        : `${Math.max(0, Math.floor(ageMs / 60_000))} minutes old`;

    lastPublished = null;
    if (persistProcessorState()) {
        log(`[Dedup] Previous published alert expired (${reason}); new reports will be evaluated as new incidents.`);
    } else {
        // Keep the in-memory expiry even if disk is temporarily unavailable. A restart will
        // re-evaluate the persisted timestamp and expire it again instead of suppressing forever.
        log("[State] Expired alert cleared in memory, but the state-file update failed.");
    }
    return true;
}

function splitTargets(value) {
    return (value || "").split(",").map(s => s.trim()).filter(Boolean);
}

function mergeTargets(existing, incoming) {
    const all = [...new Set([...splitTargets(existing), ...splitTargets(incoming)])];
    // Only collapse a general region and its parenthesized sub-region; avoid arbitrary substring matches.
    const merged = all.filter(item => !all.some(other =>
        other !== item && item.startsWith(`${other} (`) && item.endsWith(")")
    ));
    return merged.sort().join(", ");
}

function targetsOverlap(left, right) {
    const a = splitTargets(left);
    const b = splitTargets(right);
    if (!a.length || !b.length) return false;
    return a.some(x => b.some(y =>
        x === y || x.startsWith(`${y} (`) || y.startsWith(`${x} (`)
    ));
}

function isDifferentIncident(event, published) {
    if (!published) return true;
    if (event.source && published.source && event.source !== published.source) return true;
    // Two corroborated reports to disjoint targets should not be blindly merged as an update.
    if (event.target && published.target && !targetsOverlap(event.target, published.target)) return true;
    return false;
}

function cleanupExpiredEvents(now) {
    const expired = Object.entries(activeEvents).filter(([, event]) =>
        !event.deliveryPending && now - event.lastSeen > CONTEXT_WINDOW_MS
    );
    if (expired.length === 0) return true;
    for (const [id] of expired) delete activeEvents[id];
    if (persistProcessorState()) return true;
    // Keep the in-memory copy if the expiry could not be committed to disk.
    for (const [id, event] of expired) activeEvents[id] = event;
    return false;
}

function removeEvent(eventId) {
    const event = activeEvents[eventId];
    if (!event) return true;
    delete activeEvents[eventId];
    if (persistProcessorState()) return true;
    activeEvents[eventId] = event;
    return false;
}

function findMatchingEvent(classification, kind) {
    const source = classification.source || "";
    const target = classification.target || "";
    const estimatedTime = classification.estimated_time || "";

    const candidates = Object.values(activeEvents).filter(event => {
        if (event.kind !== kind) return false;
        if (source && event.source && source !== event.source) return false;

        const targetMatch = target && event.target && targetsOverlap(target, event.target);
        if (kind === "UPDATE_TO_LAST") {
            // An update is tied to the currently published event. Its target includes prior known areas,
            // so a target match is the strongest available correlation signal.
            if (targetMatch) return true;
            if (!target || !event.target) return !estimatedTime || !event.estimated_time || estimatedTime === event.estimated_time;
            return false;
        }

        if (targetMatch) return true;
        // A different known target is a contradiction, even when the incoming report omits its source.
        if (target && event.target) return false;
        // Partial reports may be joined only if there is no contradiction. The caller merges only
        // a unique compatible candidate; ambiguous source-only/target-only reports stay separate.
        const hasPartialFields = !source || !event.source || !target || !event.target;
        return hasPartialFields && Boolean(source || event.source || target || event.target);
    });

    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
        // Prefer a uniquely exact source/target match; otherwise leave the reports separate.
        const exact = candidates.filter(event =>
            (!source || event.source === source) && (!target || event.target === target)
        );
        if (exact.length === 1) return exact[0];
    }
    return null;
}

function createEvent(classification, kind, now) {
    const id = `event-${nextEventId++}`;
    activeEvents[id] = {
        id,
        kind,
        channels: new Set(),
        messages: [],
        messageKeys: new Set(),
        source: classification.source || "",
        target: classification.target || "",
        estimated_time: classification.estimated_time || "",
        firstSeen: now,
        lastSeen: now,
    };
    return activeEvents[id];
}

function addMessageToEvent(event, channelId, messageText, messageId, messageTimestamp, now) {
    const messageKey = messageId !== undefined && messageId !== null
        ? `${channelId}:${messageId}`
        : `${channelId}:${messageText}`;

    event.lastSeen = now;
    event.channels.add(String(channelId));
    if (event.messageKeys.has(messageKey)) return;

    event.messageKeys.add(messageKey);
    event.messages.push({
        channel: String(channelId),
        messageId: messageId === undefined ? null : messageId,
        text: messageText,
        // Save the message's original time so relative expressions don't drift on retry.
        time: messageTimestamp ? normalizeTimestamp(messageTimestamp) : now,
    });
}

function normalizeTimestamp(value) {
    if (value instanceof Date) return value.getTime();
    const n = Number(value);
    if (!Number.isFinite(n)) return Date.now();
    return n < 1e12 ? n * 1000 : n;
}

function mergeClassificationIntoEvent(event, classification) {
    if (classification.source && !event.source) event.source = classification.source;
    if (classification.target) event.target = mergeTargets(event.target, classification.target);
    if (classification.estimated_time) event.estimated_time = classification.estimated_time;
}

async function publishNewAlert(event, callbacks) {
    const result = await callbacks.alert(event.source, event.target, event.estimated_time);
    if (!result) {
        // A failed external delivery is an outbox item, not a short-lived correlation event.
        // Keep it until delivery succeeds so an outage longer than CONTEXT_WINDOW_MS cannot
        // silently discard an alert while Telegram's cursor is correctly held back.
        event.deliveryPending = true;
        const persisted = persistProcessorState();
        if (!persisted) {
            log(`[Dispatch] Could not persist pending delivery state for ${event.id}; Telegram cursor will remain unchanged.`);
        }
        log(`[Dispatch] ❌ Alert delivery failed; retaining ${event.id} for retry.`);
        return false;
    }
    return removeEvent(event.id);
}

async function publishUpdate(event, callbacks) {
    if (!lastPublished) return true;

    const mergedTarget = mergeTargets(lastPublished.target, event.target);
    const finalTarget = mergedTarget || lastPublished.target || "";
    const finalTime = event.estimated_time || lastPublished.estimated_time || "";
    const finalSource = event.source || lastPublished.source || "";
    const hasNewTarget = finalTarget !== (lastPublished.target || "");
    const hasNewTime = Boolean(finalTime && finalTime !== lastPublished.estimated_time);

    if (!hasNewTarget && !hasNewTime) {
        const removed = removeEvent(event.id);
        log(`[Dedup] No new actionable information in ${event.id}.`);
        return removed;
    }

    const updateType = hasNewTarget && hasNewTime ? "target+time" : hasNewTarget ? "target" : "time";
    const result = await callbacks.update(
        { source: finalSource, target: finalTarget, estimated_time: finalTime },
        lastPublished,
        updateType
    );
    if (!result) {
        // Failed updates must survive the same context-window cleanup as failed new alerts.
        event.deliveryPending = true;
        const persisted = persistProcessorState();
        if (!persisted) {
            log(`[Dispatch] Could not persist pending update state for ${event.id}; Telegram cursor will remain unchanged.`);
        }
        log(`[Dispatch] ❌ Update delivery failed; retaining ${event.id} for retry.`);
        return false;
    }

    return removeEvent(event.id);
}

async function processMessage(channelId, messageText, callbacks, messageId = null, messageTimestamp = null) {
    const now = Date.now();
    expireStaleLastPublished(now);
    if (!cleanupExpiredEvents(now)) return false;

    let classification;
    try {
        classification = await classifyMessage(channelId, messageText, lastPublished, messageTimestamp);
    } catch (error) {
        log(`[Processor] Classification threw; message will be retried: ${error.message || error}`);
        return false;
    }

    if (!classification || typeof classification.category !== "string") {
        log("[Processor] Classifier returned an invalid result; message will be retried.");
        return false;
    }
    log(`[Hybrid-AI] Category: ${classification.category} | Reasoning: ${classification.reasoning}`);

    // An API outage or malformed AI output is not the same as a valid IRRELEVANT classification.
    if (classification.category === "PROCESSING_ERROR") return false;
    if (classification.category === "IRRELEVANT") return true;
    if (!["LAUNCH_REPORT", "UPDATE_TO_LAST"].includes(classification.category)) {
        log("[Processor] Unknown classifier category; retaining message for retry.");
        return false;
    }

    // Updates must also be corroborated by multiple configured channels. One channel cannot
    // bypass the confirmation rule and publish an unverified change immediately.
    if (classification.category === "UPDATE_TO_LAST" && !lastPublished) return true;

    const kind = classification.category;
    const event = findMatchingEvent(classification, kind) || createEvent(classification, kind, now);
    mergeClassificationIntoEvent(event, classification);
    addMessageToEvent(event, channelId, messageText, messageId, messageTimestamp, now);
    // Persist pending correlation state before the Telegram cursor is allowed to advance.
    if (!persistProcessorState()) return false;

    log(`[Events] ${event.id}: ${event.channels.size}/${MIN_CHANNELS_TO_ACT} channels confirmed.`);
    if (event.channels.size < MIN_CHANNELS_TO_ACT) return true;

    if (kind === "UPDATE_TO_LAST") return publishUpdate(event, callbacks);

    if (isDifferentIncident(event, lastPublished)) {
        log(`[Publish] Corroborated new incident: ${event.source || "unknown source"} -> ${event.target || "unknown target"}`);
        return publishNewAlert(event, callbacks);
    }

    const newInfoCheck = await checkForNewInfo(event.messages, lastPublished);
    if (!newInfoCheck.has_new_info) {
        log(`[Dedup] ${newInfoCheck.reasoning}`);
        return removeEvent(event.id);
    }

    const finalTarget = mergeTargets(lastPublished.target, newInfoCheck.target);
    const finalTime = newInfoCheck.estimated_time || lastPublished.estimated_time;
    const finalSource = newInfoCheck.source || lastPublished.source;
    const hasNewTarget = finalTarget !== (lastPublished.target || "");
    const hasNewTime = Boolean(finalTime && finalTime !== lastPublished.estimated_time);

    if (!hasNewTarget && !hasNewTime) {
        return removeEvent(event.id);
    }

    const updateType = hasNewTarget && hasNewTime ? "target+time" : hasNewTarget ? "target" : "time";
    const result = await callbacks.update(
        { source: finalSource, target: finalTarget, estimated_time: finalTime },
        lastPublished,
        updateType
    );
    if (!result) {
        log(`[Dispatch] ❌ Update delivery failed; retaining ${event.id} for retry.`);
        return false;
    }

    return removeEvent(event.id);
}

module.exports = {
    processMessage,
    setLastPublished,
    getLastPublished,
    getActiveEvents,
    // Exported for deterministic unit tests only.
    expireStaleLastPublished,
    mergeTargets,
    targetsOverlap,
};
