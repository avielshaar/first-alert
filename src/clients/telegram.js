/**
 * Telegram Client Module
 * Reads every new message in chronological order and advances the cursor only after
 * processing succeeds. Failed processing is retried on the next polling pass.
 */

const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const { log } = require("../utils/logger");
const { TELEGRAM_API_ID, TELEGRAM_API_HASH, ALERT_CHANNELS } = require("../config");
const { processMessage } = require("../messaging/processor");

let telegramClient = null;
const cursorFile = process.env.TELEGRAM_CURSOR_FILE || "./data/telegram-cursors.json";
const { readCursorState, writeCursorState } = require("./telegram-cursor-store");
const cursorState = readCursorState(cursorFile, ALERT_CHANNELS);
const lastSeenMessageIds = { ...cursorState.cursors };
const initializedChannels = new Set(cursorState.initializedChannels);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let polling = false;
let pollingTask = null;
let pollingSupervisorTask = null;
let telegramStartTask = null;
let shutdownRequested = false;
const pendingBaselineByChannel = new Map();
const retryAfterByChannel = new Map();

if (cursorState.error) {
    log(`[Telegram] Cursor state is invalid: ${cursorState.error}. Fresh baselining is disabled to avoid skipping unprocessed alerts.`);
}

function persistMessageCursor(channelId, messageId) {
    const next = writeCursorState(cursorFile, lastSeenMessageIds, channelId, messageId);
    Object.assign(lastSeenMessageIds, next);
    initializedChannels.add(String(channelId));
}

function startTelegramClient(callbacks) {
    if (shutdownRequested) {
        return Promise.reject(new Error("Telegram is shutting down; refusing to initialize a new client."));
    }
    if (telegramClient && (polling || pollingSupervisorTask)) {
        log("[Telegram] Client is already running or recovery is scheduled; skipping duplicate initialization.");
        return Promise.resolve();
    }
    if (telegramStartTask) return telegramStartTask;

    telegramStartTask = startTelegramClientInternal(callbacks)
        .finally(() => { telegramStartTask = null; });
    return telegramStartTask;
}

async function startTelegramClientInternal(callbacks) {
    if (cursorState.error) {
        const error = new Error(
            "Telegram cursor state is invalid (" + cursorState.error +
            "). Refusing to establish a fresh baseline because it could skip unprocessed alerts. " +
            "Back up and repair the cursor file, then restart the application."
        );
        error.retryable = false;
        throw error;
    }
    if (telegramClient) {
        try { await telegramClient.disconnect(); } catch (_) { /* replace a stale failed client */ }
        telegramClient = null;
    }

    log("[Telegram] Initializing client...");
    const dataDir = process.env.APP_DATA_DIR || "./data";
    const sessionFile = process.env.TELEGRAM_SESSION_FILE || path.join(dataDir, "telegram_session");
    const legacySessionFile = "./.telegram_session";
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    if (!fs.existsSync(sessionFile) && fs.existsSync(legacySessionFile)) {
        // Migrate the previous session location so an upgrade doesn't force re-authentication.
        fs.copyFileSync(legacySessionFile, sessionFile);
        try { fs.chmodSync(sessionFile, 0o600); } catch (_) { /* best effort */ }
        log("[Telegram] Migrated legacy session file to the persistent data directory.");
    }
    let sessionString = "";
    if (fs.existsSync(sessionFile)) sessionString = fs.readFileSync(sessionFile, "utf8");

    const stringSession = new StringSession(sessionString);
    const client = new TelegramClient(stringSession, TELEGRAM_API_ID, TELEGRAM_API_HASH, {
        connectionRetries: 5,
    });
    telegramClient = client;

    try {
        await client.start({
            phoneNumber: async () => input.text("[Telegram Auth] Enter your phone number: "),
            password: async () => input.text("[Telegram Auth] Enter your 2FA password: "),
            phoneCode: async () => input.text("[Telegram Auth] Enter the code: "),
            onError: err => log("[Telegram Auth] Error: " + (err.message || err)),
        });
        if (shutdownRequested) throw new Error("Telegram startup interrupted by shutdown.");

        fs.writeFileSync(sessionFile, client.session.save(), { mode: 0o600 });
        try { fs.chmodSync(sessionFile, 0o600); } catch (_) { /* best effort */ }
        log("[Telegram] ✅ Connected successfully!");

        log("[Telegram] 🔍 Initializing trackers...");
    for (const id of ALERT_CHANNELS) {
        if (!id) continue;
        if (initializedChannels.has(String(id))) {
            log(`[Telegram] Restored cursor for ${id}: ${lastSeenMessageIds[id]}`);
            continue;
        }
        try {
            const msgs = await client.getMessages(id, { limit: 1 });
            const baselineId = msgs && msgs.length > 0 ? msgs[0].id : 0;
            // Retain the first observed baseline if writing it fails. Never re-query the latest
            // message and move the cursor forward after a storage error, which could skip alerts.
            pendingBaselineByChannel.set(String(id), baselineId);
            persistMessageCursor(id, baselineId);
            pendingBaselineByChannel.delete(String(id));
            if (baselineId > 0) {
                log(`[Telegram] Tracking initialized for ID: ${id}, baseline ${baselineId}`);
            } else {
                log(`[Telegram] No existing messages found for ${id}; will start from first available message.`);
            }
        } catch (err) {
            if (!initializedChannels.has(String(id)) && !pendingBaselineByChannel.has(String(id))) {
                // If Telegram was temporarily unavailable before a safe baseline could be read,
                // start at zero when it recovers and drain history rather than silently skipping it.
                pendingBaselineByChannel.set(String(id), 0);
            }
            log(`[Telegram] Could not initialize tracker for ${id}: ${err.message || err}`);
        }
        await sleep(300);
    }

        log("[Telegram] 🔍 Listening for new messages...");
        startPollingSupervisor(callbacks);
    } catch (error) {
        if (telegramClient === client) telegramClient = null;
        polling = false;
        try { await client.disconnect(); } catch (disconnectError) {
            log(`[Telegram] Cleanup after startup failure: ${disconnectError.message || disconnectError}`);
        }
        throw error;
    }
}

function startPolling(callbacks) {
    if (pollingTask) return pollingTask;
    polling = true;
    pollingTask = (async () => {
        while (polling) {
            for (const id of ALERT_CHANNELS) {
                if (!polling) break;
                if (!id) continue;
                if (Date.now() < (retryAfterByChannel.get(String(id)) || 0)) continue;

                try {
                    if (!initializedChannels.has(String(id))) {
                        const channelKey = String(id);
                        const baselineId = pendingBaselineByChannel.has(channelKey)
                            ? pendingBaselineByChannel.get(channelKey)
                            : 0;
                        // Do not move an uninitialized cursor to "latest" after a failed write/read.
                        // Cursor zero safely drains the backlog if no trustworthy baseline is available.
                        persistMessageCursor(id, baselineId);
                        pendingBaselineByChannel.delete(channelKey);
                        log(`[Telegram] Tracker recovered for ${id}; cursor initialized at ${baselineId}.`);
                        continue;
                    }
                    const cursor = lastSeenMessageIds[id] || 0;
                    // iterMessages + reverse gets messages oldest-first. With minId, a backlog is
                    // drained in order instead of fetching only the latest message and skipping gaps.
                    for await (const message of telegramClient.iterMessages(id, {
                        minId: cursor,
                        reverse: true,
                    })) {
                        if (!polling) break;
                        const previousId = lastSeenMessageIds[id] || 0;
                        if (!message || !message.id || message.id <= previousId) continue;

                        try {
                            const hasText = typeof message.message === "string" && message.message.trim().length > 0;
                            if (hasText) {
                                const telegramSentAt = message.date
                                    ? new Date(Number(message.date) * 1000).toISOString()
                                    : "unknown";
                                log(`[Telegram] Received message | channel=${id} | message_id=${message.id} | sent_at=${telegramSentAt} | cursor_before=${previousId}`);
                                const processed = await processMessage(
                                    id,
                                    message.message,
                                    callbacks,
                                    message.id,
                                    message.date
                                );
                                if (processed === false) {
                                    retryAfterByChannel.set(String(id), Date.now() + 3000);
                                    log(`[Telegram] Processing not committed | channel=${id} | message_id=${message.id} | cursor_remains=${previousId} | retry_after_ms=3000; the same message will be retried.`, "WARN");
                                    break;
                                }
                                retryAfterByChannel.delete(String(id));
                            } else {
                                log(`[Telegram] Non-text/empty message | channel=${id} | message_id=${message.id} | action=skip-content-and-advance-cursor`);
                            }
                            // Persist before proceeding. If writing the cursor fails, retry this
                            // message rather than advancing in-memory state beyond the durable state.
                            persistMessageCursor(id, message.id);
                            log(`[Telegram] Cursor persisted | channel=${id} | previous=${previousId} | current=${message.id} | outcome=${hasText ? "message-processed" : "non-text-message-acknowledged"}`);
                        } catch (err) {
                            retryAfterByChannel.set(String(id), Date.now() + 3000);
                            log(`[Telegram] Processing/persistence error for ${id}/${message.id}; cursor not advanced: ${err.message || err}`);
                            break;
                        }
                    }
                } catch (err) {
                    const message = String(err && err.message ? err.message : err);
                    log(`[Telegram] Polling error for ${id}: ${message}`);
                    const backoffMs = /FLOOD|429/i.test(message) ? 10000 : 3000;
                    retryAfterByChannel.set(String(id), Date.now() + backoffMs);
                }
                await sleep(300);
            }
            if (polling) await sleep(1000);
        }
    })().catch(err => {
        polling = false;
        log(`[Telegram] Polling loop stopped unexpectedly: ${err.message || err}`);
    }).finally(() => {
        pollingTask = null;
    });
    return pollingTask;
}

function startPollingSupervisor(callbacks) {
    if (pollingSupervisorTask || shutdownRequested) return pollingSupervisorTask;
    pollingSupervisorTask = (async () => {
        let restartDelayMs = 1000;
        while (telegramClient && !shutdownRequested) {
            await startPolling(callbacks);
            if (!telegramClient || shutdownRequested) break;

            log(`[Telegram] Polling loop exited unexpectedly; restarting in ${restartDelayMs}ms.`);
            await sleep(restartDelayMs);
            restartDelayMs = Math.min(restartDelayMs * 2, 30_000);
        }
    })().catch(error => {
        log(`[Telegram] Polling supervisor stopped: ${error.message || error}`);
    }).finally(() => {
        pollingSupervisorTask = null;
    });
    return pollingSupervisorTask;
}

async function shutdownTelegram() {
    shutdownRequested = true;
    polling = false;
    if (telegramClient) {
        try {
            await telegramClient.disconnect();
        } catch (err) {
            log(`[Telegram] Disconnect warning: ${err.message || err}`);
        }
    }
    // The current request should end on disconnect; don't block process shutdown indefinitely.
    telegramClient = null;
}

module.exports = { startTelegramClient, startPolling, shutdownTelegram };
