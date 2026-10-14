/**
 * Message Processing and Event Tracking Module.
 *
 * Each incident is represented by one event object. Correlation is performed against
 * event attributes instead of storing the same incident under several partial keys.
 * A message is considered processed only after classification and any required publish
 * operation complete successfully; returning false asks the Telegram poller to retry it.
 */

const { log } = require("../utils/logger");
const { classifyMessage, extractSource, extractTargets, extractTime } = require("./classifier");
const {
    CONTEXT_WINDOW_MS,
    LAST_PUBLISHED_DEDUP_WINDOW_MS,
    MIN_CHANNELS_TO_ACT,
} = require("../config");
const {
    splitTargets,
    mergeTargets,
    targetsOverlap,
    isDifferentIncident,
    findMatchingEvent,
} = require("../domain/event-correlation");
const {
    getEvidenceMessages,
    getTargetVoteMap,
    getCorroboratedFields,
    getCorroboratedTime,
    getPendingUncorroboratedFields,
} = require("../domain/field-verification");
const { safelyExtract, hydrateMessageEvidence } = require("../domain/message-evidence");
const { readJsonStateFile, writeJsonStateFile } = require("../infrastructure/processor-state-file");

const stateFile = process.env.FIRST_ALERT_STATE_FILE || "./data/processor-state.json";
const activeEvents = {};
let lastPublished = null;
let nextEventId = 1;
// If an in-memory state transition cannot be saved, hold the Telegram cursor until persistence recovers.
let stateNeedsPersistence = false;

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
    try {
        writeJsonStateFile(stateFile, payload);
        stateNeedsPersistence = false;
        return true;
    } catch (error) {
        stateNeedsPersistence = true;
        log(`[State] Could not persist processor state to ${stateFile}: ${error.message || error}`);
        return false;
    }
}



function loadProcessorState() {
    try {
        const storedState = readJsonStateFile(stateFile);
        if (!storedState.exists) return;
        const parsed = storedState.value;
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
            const keyMatch = /^event-(\d+)$/.exec(id);
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
                // Older state files lack per-message evidence. Rebuild it from original text.
                messages: raw.messages.map(message => hydrateMessageEvidence(message, { extractSource, extractTargets, extractTime })),
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
            "Processor state is invalid or unreadable: " + (error.message || String(error)) + ". " +
            "Refusing to start to avoid losing pending incident evidence. " +
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
            // Only values created by the field-verified flow are trusted as corroborated baselines.
            verificationVersion: 1,
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

// Older persisted baselines were created before per-field confirmation existed. Do not reuse
// their source, target, or time as verified facts; a new event must reconfirm those fields.
function getVerifiedLastPublished() {
    return lastPublished && lastPublished.verificationVersion === 1 ? lastPublished : null;
}

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

function addMessageToEvent(event, channelId, messageText, messageId, messageTimestamp, now, classification) {
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
        // Store this message's evidence separately from merged or previously published values.
        reportedSource: typeof classification.reportedSource === "string"
            ? classification.reportedSource
            : String(classification.source || ""),
        reportedTarget: typeof classification.reportedTarget === "string"
            ? classification.reportedTarget
            : String(classification.target || ""),
        reportedEstimatedTime: typeof classification.reportedEstimatedTime === "string"
            ? classification.reportedEstimatedTime
            : String(classification.estimated_time || ""),
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

async function publishNewAlert(event, callbacks, verifiedFields) {
    let result = false;
    try {
        log(`[Dispatch] event=${event.id} | action=SEND_NEW_ALERT | verified_fields={source:${JSON.stringify(verifiedFields.source || "—")}, target:${JSON.stringify(verifiedFields.target || "—")}, time:${JSON.stringify(verifiedFields.estimated_time || "—")}} | unverified_fields_are_omitted=true.`);
        result = await callbacks.alert(
            verifiedFields.source || "",
            verifiedFields.target || "",
            verifiedFields.estimated_time || ""
        );
    } catch (error) {
        log(`[Dispatch] Alert callback threw for ${event.id}: ${error.message || error}`);
    }
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

    lastPublished = {
        source: verifiedFields.source || "",
        target: verifiedFields.target || "",
        estimated_time: verifiedFields.estimated_time || "",
        verificationVersion: 1,
        publishedAt: Date.now(),
    };
    log(`[Dispatch] event=${event.id} | outcome=ALERT_DELIVERED | published_baseline={source:${JSON.stringify(lastPublished.source || "—")}, target:${JSON.stringify(lastPublished.target || "—")}, time:${JSON.stringify(lastPublished.estimated_time || "—")}}.`);
    delete event.deliveryPending;

    const pendingFields = getPendingUncorroboratedFields(event, lastPublished);
    // Keep a two-minute evidence window even after an alert is sent. This lets a third
    // independent channel refine the ETA (median/range) and helps verify any field omitted
    // from the first publication without delaying the initial two-channel alert.
    event.kind = "UPDATE_TO_LAST";
    event.corroborationPending = true;
    if (pendingFields.length > 0) {
        log(`[Verification] ${event.id} sent verified fields only; waiting for: ${pendingFields.join(", ")}.`);
    }
    return persistProcessorState();
}

async function publishUpdate(event, callbacks, evidence = getCorroboratedFields(event)) {
    if (!lastPublished) return true;

    const mergedTarget = mergeTargets(lastPublished.target, evidence.target);
    const finalTarget = mergedTarget || lastPublished.target || "";
    const finalTime = evidence.estimated_time || lastPublished.estimated_time || "";
    const finalSource = evidence.source || lastPublished.source || "";
    const hasNewSource = Boolean(finalSource && finalSource !== (lastPublished.source || ""));
    const hasNewTarget = finalTarget !== (lastPublished.target || "");
    const hasNewTime = Boolean(finalTime && finalTime !== lastPublished.estimated_time);

    if (!hasNewSource && !hasNewTarget && !hasNewTime) {
        const pendingFields = getPendingUncorroboratedFields(event, lastPublished);
        if (pendingFields.length > 0 || event.corroborationPending) {
            event.corroborationPending = true;
            if (pendingFields.length > 0) {
                log(`[Verification] ${event.id} waiting for independent confirmation of: ${pendingFields.join(", ")}.`);
            } else {
                log(`[Events] Keeping ${event.id} open briefly to collect additional channel evidence.`);
            }
            return persistProcessorState();
        }
        const removed = removeEvent(event.id);
        log(`[Dedup] No new corroborated information in ${event.id}.`);
        return removed;
    }

    const updateType = [
        hasNewSource && "source",
        hasNewTarget && "target",
        hasNewTime && "time",
    ].filter(Boolean).join("+");
    log(`[Dispatch] event=${event.id} | action=SEND_UPDATE | changed_fields=[${updateType}] | previous={source:${JSON.stringify(lastPublished.source || "—")}, target:${JSON.stringify(lastPublished.target || "—")}, time:${JSON.stringify(lastPublished.estimated_time || "—")}} | proposed_confirmed={source:${JSON.stringify(finalSource || "—")}, target:${JSON.stringify(finalTarget || "—")}, time:${JSON.stringify(finalTime || "—")}}.`);
    let result = false;
    try {
        result = await callbacks.update(
            { source: finalSource, target: finalTarget, estimated_time: finalTime },
            lastPublished,
            updateType
        );
    } catch (error) {
        log(`[Dispatch] Update callback threw for ${event.id}: ${error.message || error}`);
    }
    if (!result) {
        event.deliveryPending = true;
        const persisted = persistProcessorState();
        if (!persisted) {
            log(`[Dispatch] Could not persist pending update state for ${event.id}; Telegram cursor will remain unchanged.`);
        }
        log(`[Dispatch] ❌ Update delivery failed; retaining ${event.id} for retry.`);
        return false;
    }

    lastPublished = {
        source: finalSource,
        target: finalTarget,
        estimated_time: finalTime,
        verificationVersion: 1,
        publishedAt: Date.now(),
    };
    log(`[Dispatch] event=${event.id} | outcome=UPDATE_DELIVERED | baseline_now={source:${JSON.stringify(finalSource || "—")}, target:${JSON.stringify(finalTarget || "—")}, time:${JSON.stringify(finalTime || "—")}}.`);
    delete event.deliveryPending;

    const pendingFields = getPendingUncorroboratedFields(event, lastPublished);
    event.corroborationPending = true;
    if (pendingFields.length > 0) {
        log(`[Verification] ${event.id} update sent using corroborated fields only; still waiting for: ${pendingFields.join(", ")}.`);
    } else {
        log(`[Events] Keeping ${event.id} open briefly for additional ETA/evidence reports.`);
    }
    return persistProcessorState();
}

// Attach a terse region-only follow-up (for example, "מרכז") to a unique, recent
// source-only launch event. It is recorded as evidence, not treated as an alert on its own.
function attachRegionOnlyFollowUp(channelId, messageText, messageId, messageTimestamp, now) {
    const text = String(messageText || "").trim();
    if (!text || text.length > 25) return null;

    const source = safelyExtract(extractSource, text);
    const target = safelyExtract(extractTargets, text);
    const estimatedTime = safelyExtract(extractTime, text, messageTimestamp || now);
    if (source || !target || estimatedTime) return null;

    const published = getVerifiedLastPublished();
    const candidates = Object.values(activeEvents).filter(event => {
        if (
            event.deliveryPending ||
            !event.source ||
            now - event.lastSeen > CONTEXT_WINDOW_MS
        ) return false;

        // Before initial publication, a region-only follow-up can complete a source-only
        // launch event. After publication, keep accepting independent region-only evidence
        // while this same event is still open for corroboration.
        const incompleteLaunch = event.kind === "LAUNCH_REPORT" && !event.target;
        const pendingPublishedEvent = event.kind === "UPDATE_TO_LAST" &&
            event.corroborationPending &&
            (!event.target || splitTargets(event.target).some(existing => targetsOverlap(existing, target)));

        if (!incompleteLaunch && !pendingPublishedEvent) return false;

        // A region that is already independently corroborated or already present in the
        // published baseline needs no new attachment.
        const corroboratedTargets = splitTargets(getCorroboratedFields(event).target);
        const publishedTargets = splitTargets(published && published.target);
        if (
            corroboratedTargets.some(existing => targetsOverlap(existing, target)) ||
            publishedTargets.some(existing => targetsOverlap(existing, target))
        ) return false;

        return true;
    });

    // Never guess when more than one incomplete incident could own this region.
    if (candidates.length === 0) {
        log(`[Correlation] channel=${channelId} message=${messageId ?? "n/a"} candidate_region=${JSON.stringify(target)} | action=NOT_ATTACHED | reason=no unique open source-confirmed event within ${Math.round(CONTEXT_WINDOW_MS / 1000)}s; message will not change an incident.`);
        return null;
    }
    if (candidates.length > 1) {
        log(`[Correlation] channel=${channelId} message=${messageId ?? "n/a"} candidate_region=${JSON.stringify(target)} | action=NOT_ATTACHED | reason=${candidates.length} compatible events; refusing ambiguous correlation | events=${candidates.map(event => event.id).join(",")}.`);
        return null;
    }

    const event = candidates[0];
    // Telegram may redeliver the same message when its cursor is retried. A duplicate must
    // not refresh the event's age or mutate fields before addMessageToEvent notices the key.
    const messageKey = messageId !== undefined && messageId !== null
        ? `${channelId}:${messageId}`
        : `${channelId}:${text}`;
    if (event.messageKeys.has(messageKey)) {
        log(`[Correlation] channel=${channelId} message=${messageId ?? "n/a"} | duplicate region follow-up already attached to ${event.id}; ignoring idempotently.`);
        return event;
    }

    const partialClassification = {
        source: "",
        target,
        estimated_time: "",
        reportedSource: "",
        reportedTarget: target,
        reportedEstimatedTime: "",
    };
    mergeClassificationIntoEvent(event, partialClassification);
    addMessageToEvent(
        event, channelId, text, messageId, messageTimestamp, now, partialClassification
    );
    if (!persistProcessorState()) return false;

    const confirmed = getCorroboratedFields(event);
    const targetSupport = getTargetVoteMap(getEvidenceMessages(event)).get(target);
    const regionChannelCount = targetSupport ? targetSupport.size : 0;
    log(`[Correlation] channel=${channelId} message=${messageId ?? "n/a"} | action=ATTACHED | event=${event.id} | text=${JSON.stringify(text)} | event_channels=${[...event.channels].join(",")} (${event.channels.size}/${MIN_CHANNELS_TO_ACT} required) | region=${JSON.stringify(target)} support=${regionChannelCount}/${MIN_CHANNELS_TO_ACT} independent channels | confirmed_source=${confirmed.source || "—"} | confirmed_target=${confirmed.target || "—"}.`);
    return event;
}

async function processAttachedRegionFollowUp(event, callbacks, channelId, messageId) {
    if (!event || event.deliveryPending) {
        log(`[Correlation] channel=${channelId} message=${messageId ?? "n/a"} | attachment could not be safely processed; retaining message for retry.`, "WARN");
        return false;
    }

    const publishedBaseline = getVerifiedLastPublished();
    const evidence = getCorroboratedFields(event);
    if (event.channels.size < MIN_CHANNELS_TO_ACT) {
        log(`[Verification] event=${event.id} | attached follow-up recorded, but event-level confirmation is ${event.channels.size}/${MIN_CHANNELS_TO_ACT} channels | confirmed_source=${evidence.source || "—"} | confirmed_target=${evidence.target || "—"} | waiting for another configured channel.`);
        return true;
    }

    if (!publishedBaseline) {
        if (!evidence.source && !evidence.target) {
            log(`[Verification] ${event.id} still lacks an independently corroborated source or target.`);
            return true;
        }
        log(`[Publish] Corroborated new incident from attached follow-up: ${evidence.source || "unverified source"} -> ${evidence.target || "unverified target"}`);
        return publishNewAlert(event, callbacks, evidence);
    }

    if (isDifferentIncident(evidence, publishedBaseline)) {
        if (!evidence.source && !evidence.target) {
            log(`[Verification] ${event.id} still lacks an independently corroborated source or target.`);
            return true;
        }
        log(`[Publish] Corroborated new incident from attached follow-up: ${evidence.source || "unverified source"} -> ${evidence.target || "unverified target"}`);
        return publishNewAlert(event, callbacks, evidence);
    }

    return publishUpdate(event, callbacks, evidence);
}

async function processMessage(channelId, messageText, callbacks, messageId = null, messageTimestamp = null) {
    // Do not classify or acknowledge a new Telegram message while a previous state transition
    // remains unsaved. Retry persistence first so a successful send is not blindly repeated.
    if (stateNeedsPersistence && !persistProcessorState()) return false;

    const now = Date.now();
    expireStaleLastPublished(now);
    if (!cleanupExpiredEvents(now)) return false;

    const publishedBaseline = getVerifiedLastPublished();
    let classification;
    try {
        classification = await classifyMessage(channelId, messageText, publishedBaseline, messageTimestamp);
    } catch (error) {
        log(`[Processor] Classification threw; message will be retried: ${error.message || error}`);
        return false;
    }

    if (!classification || typeof classification.category !== "string") {
        log("[Processor] Classifier returned an invalid result; message will be retried.");
        return false;
    }
    const messageRef = `channel=${String(channelId)} message=${messageId ?? "n/a"}`;
    const messagePreview = String(messageText || "").replace(/\s+/g, " ").slice(0, 100);
    const rawSource = typeof classification.reportedSource === "string"
        ? classification.reportedSource : safelyExtract(extractSource, messageText);
    const rawTarget = typeof classification.reportedTarget === "string"
        ? classification.reportedTarget : safelyExtract(extractTargets, messageText);
    const rawTime = typeof classification.reportedEstimatedTime === "string"
        ? classification.reportedEstimatedTime : safelyExtract(extractTime, messageText, messageTimestamp || now);
    const reason = String(classification.reasoning || "No reasoning provided").replace(/\s+/g, " ").slice(0, 240);

    if (classification.category === "IRRELEVANT") {
        log(`[Classifier] ${messageRef} | category=IRRELEVANT | scope=message-by-itself | text=${JSON.stringify(messagePreview)} | deterministic_fields={source:${JSON.stringify(rawSource || "—")}, target:${JSON.stringify(rawTarget || "—")}, time:${JSON.stringify(rawTime || "—")}} | reason=${JSON.stringify(reason)} | next_step=check-contextual-follow-up`);
    } else {
        log(`[Classifier] ${messageRef} | category=${classification.category} | resolved_fields={source:${JSON.stringify(classification.source || "—")}, target:${JSON.stringify(classification.target || "—")}, time:${JSON.stringify(classification.estimated_time || "—")}} | raw_message_evidence={source:${JSON.stringify(rawSource || "—")}, target:${JSON.stringify(rawTarget || "—")}, time:${JSON.stringify(rawTime || "—")}} | text=${JSON.stringify(messagePreview)} | reason=${JSON.stringify(reason)}`);
    }

    // An API outage or malformed AI output is not the same as a valid IRRELEVANT classification.
    if (classification.category === "PROCESSING_ERROR") {
        log(`[Processor] ${messageRef} | outcome=RETRY | reason=classifier returned PROCESSING_ERROR; Telegram cursor must remain unchanged.`, "WARN");
        return false;
    }
    if (classification.category === "IRRELEVANT") {
        const attached = attachRegionOnlyFollowUp(
            channelId, messageText, messageId, messageTimestamp, now
        );
        if (attached === null) {
            log(`[Correlation] ${messageRef} | outcome=NO_CONTEXT_MATCH | action=ACKNOWLEDGE | reason=message was not attached to a unique eligible incident; no event fields changed and no alert will be sent.`);
            return true;
        }
        if (attached === false) {
            log(`[Correlation] ${messageRef} | outcome=STATE_SAVE_FAILED | action=RETRY | reason=follow-up evidence was not durably saved.`, "WARN");
            return false;
        }
        return processAttachedRegionFollowUp(attached, callbacks, channelId, messageId);
    }
    if (!["LAUNCH_REPORT", "UPDATE_TO_LAST"].includes(classification.category)) {
        log("[Processor] Unknown classifier category; retaining message for retry.");
        return false;
    }

    // Updates must also be corroborated by multiple configured channels. One channel cannot
    // bypass the confirmation rule and publish an unverified change immediately.
    if (classification.category === "UPDATE_TO_LAST" && !publishedBaseline) return true;

    const kind = classification.category;
    const matchedEvent = findMatchingEvent(classification, kind, activeEvents);
    const event = matchedEvent || createEvent(classification, kind, now);
    mergeClassificationIntoEvent(event, classification);
    addMessageToEvent(event, channelId, messageText, messageId, messageTimestamp, now, classification);
    // Persist pending correlation state before the Telegram cursor is allowed to advance.
    if (!persistProcessorState()) {
        log(`[State] event=${event.id} | could not persist newly collected message evidence; Telegram cursor will not advance.`, "ERROR");
        return false;
    }

    const evidence = getCorroboratedFields(event);
    const pendingFields = getPendingUncorroboratedFields(event, publishedBaseline);
    log(`[Correlation] ${messageRef} | action=${matchedEvent ? "MERGE_INTO_EXISTING" : "CREATE_EVENT"} | event=${event.id} | event_kind=${event.kind} | channels=${event.channels.size}/${MIN_CHANNELS_TO_ACT} required [${[...event.channels].join(", ")}] | stored_messages=${event.messages.length} | confirmed_fields={source:${JSON.stringify(evidence.source || "—")}, target:${JSON.stringify(evidence.target || "—")}, time:${JSON.stringify(evidence.estimated_time || "—")}} | pending_field_verification=[${pendingFields.join(", ") || "none"}].`);
    if (event.channels.size < MIN_CHANNELS_TO_ACT) {
        log(`[Verification] event=${event.id} | event confirmation=${event.channels.size}/${MIN_CHANNELS_TO_ACT} channels; waiting for ${MIN_CHANNELS_TO_ACT - event.channels.size} additional independent channel(s).`);
        return true;
    }

    if (!publishedBaseline) {
        // Do not block a corroborated incident just because one optional field (usually
        // the target region) has only one channel's support. Publish only independently
        // corroborated source/target fields; unverified fields remain blank and may be
        // added later when another channel confirms them.
        if (!evidence.source && !evidence.target) {
            const pendingFields = getPendingUncorroboratedFields(event, null);
            log(`[Verification] ${event.id} waiting for at least one actionable field (source or target) to be corroborated before publishing` +
                (pendingFields.length ? ` (pending: ${pendingFields.join(", ")}).` : "."));
            return true;
        }
        log(`[Publish] Corroborated new incident: ${evidence.source || "unverified source"} -> ${evidence.target || "unverified target"}`);
        return publishNewAlert(event, callbacks, evidence);
    }

    if (isDifferentIncident(evidence, publishedBaseline)) {
        if (!evidence.target) {
            const pendingFields = getPendingUncorroboratedFields(event, lastPublished);
            log(`[Verification] ${event.id} appears different, but its target is not confirmed by two channels` +
                (pendingFields.length ? ` (pending: ${pendingFields.join(", ")}).` : "."));
            return true;
        }
        log(`[Publish] Corroborated new incident: ${evidence.source || "unverified source"} -> ${evidence.target}`);
        return publishNewAlert(event, callbacks, evidence);
    }

    // New alerts and tactical updates use the same per-field corroboration.
    return publishUpdate(event, callbacks, evidence);
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
    // Exported for deterministic field-verification tests.
    getCorroboratedFields,
    getCorroboratedTime,
};
