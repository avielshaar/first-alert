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
const lastSeenMessageIds = {};
const initializedChannels = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let polling = false;
let pollingTask = null;
const retryAfterByChannel = new Map();

function loadMessageCursors() {
    try {
        if (!fs.existsSync(cursorFile)) return;
        const parsed = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("cursor file must contain a JSON object");
        }
        for (const [channelId, rawId] of Object.entries(parsed)) {
            const id = Number(rawId);
            if (Number.isSafeInteger(id) && id >= 0) {
                lastSeenMessageIds[channelId] = id;
                initializedChannels.add(String(channelId));
            }
        }
    } catch (err) {
        log(`[Telegram] Could not load cursor file ${cursorFile}: ${err.message || err}`);
    }
}

function persistMessageCursor(channelId, messageId) {
    const numericId = Number(messageId);
    if (!Number.isSafeInteger(numericId) || numericId < 0) {
        throw new Error(`Invalid Telegram message cursor for ${channelId}`);
    }
    const next = { ...lastSeenMessageIds, [String(channelId)]: numericId };
    const tempFile = `${cursorFile}.tmp`;
    fs.mkdirSync(require("path").dirname(tempFile), { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(next, null, 2), { mode: 0o600 });
    try { fs.chmodSync(tempFile, 0o600); } catch (_) { /* permissions may be unsupported on some platforms */ }
    fs.renameSync(tempFile, cursorFile);
    lastSeenMessageIds[String(channelId)] = numericId;
    initializedChannels.add(String(channelId));
}

loadMessageCursors();

async function startTelegramClient(callbacks) {
    if (telegramClient && polling) {
        log("[Telegram] Client is already running; skipping duplicate initialization.");
        return;
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
    telegramClient = new TelegramClient(stringSession, TELEGRAM_API_ID, TELEGRAM_API_HASH, {
        connectionRetries: 5,
    });

    await telegramClient.start({
        phoneNumber: async () => input.text("[Telegram Auth] Enter your phone number: "),
        password: async () => input.text("[Telegram Auth] Enter your 2FA password: "),
        phoneCode: async () => input.text("[Telegram Auth] Enter the code: "),
        onError: err => log("[Telegram Auth] Error: " + (err.message || err)),
    });

    fs.writeFileSync(sessionFile, telegramClient.session.save(), { mode: 0o600 });
    log("[Telegram] ✅ Connected successfully!");

    log("[Telegram] 🔍 Initializing trackers...");
    for (const id of ALERT_CHANNELS) {
        if (!id) continue;
        if (initializedChannels.has(String(id))) {
            log(`[Telegram] Restored cursor for ${id}: ${lastSeenMessageIds[id]}`);
            continue;
        }
        try {
            const msgs = await telegramClient.getMessages(id, { limit: 1 });
            if (msgs && msgs.length > 0) {
                // First run only: establish a baseline so old channel history isn't replayed.
                // On later restarts, resume from the persisted cursor instead of skipping new messages.
                persistMessageCursor(id, msgs[0].id);
                log(`[Telegram] Tracking initialized for ID: ${id}, baseline ${msgs[0].id}`);
            } else {
                persistMessageCursor(id, 0);
                log(`[Telegram] No existing messages found for ${id}; will start from first available message.`);
            }
        } catch (err) {
            // The polling loop will retry initialization for channels that have no saved cursor.
            log(`[Telegram] Could not initialize tracker for ${id}: ${err.message || err}`);
        }
        await sleep(300);
    }

    log("[Telegram] 🔍 Listening for new messages...");
    void startPolling(callbacks);
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
                        const baselineMessages = await telegramClient.getMessages(id, { limit: 1 });
                        const baselineId = baselineMessages && baselineMessages.length ? baselineMessages[0].id : 0;
                        persistMessageCursor(id, baselineId);
                        log(`[Telegram] Tracker recovered for ${id}; baseline is ${baselineId}.`);
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
                            if (typeof message.message === "string" && message.message.trim()) {
                                log(`[Telegram] New message | Channel: ${id} | Message ID: ${message.id}`);
                                const processed = await processMessage(
                                    id,
                                    message.message,
                                    callbacks,
                                    message.id,
                                    message.date
                                );
                                if (processed === false) {
                                    retryAfterByChannel.set(String(id), Date.now() + 3000);
                                    log(`[Telegram] Processing failed for ${id}/${message.id}; cursor not advanced, retrying this channel after a short backoff.`);
                                    break;
                                }
                                retryAfterByChannel.delete(String(id));
                            }
                            // Empty/non-text messages are intentionally skipped, but acknowledged so they
                            // do not block every later message forever.
                            // Persist before proceeding. If writing the cursor fails, retry this
                            // message rather than advancing in-memory state beyond the durable state.
                            persistMessageCursor(id, message.id);
                        } catch (err) {
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
        log(`[Telegram] Polling loop stopped unexpectedly: ${err.message || err}`);
    }).finally(() => {
        pollingTask = null;
    });
    return pollingTask;
}

async function shutdownTelegram() {
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
