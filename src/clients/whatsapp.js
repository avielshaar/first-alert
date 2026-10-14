/**
 * WhatsApp Client Module
 */
const { Client, LocalAuth } = require("whatsapp-web.js");
const fs = require("fs");
const { log } = require("../utils/logger");
const { TARGET_WHATSAPP_GROUP, WHATSAPP_INVITE_LINK } = require("../config");
const { onReady } = require("./handlers/ready");
const {
    prepareWhatsAppAuthPath,
    findUniqueTargetGroup,
} = require("./whatsapp-helpers");

let whatsappGroupChat = null;
let whatsappClient = null;
let isReconnecting = false;
let isShuttingDown = false;
let reconnectTimer = null;
let groupResolutionTimer = null;
let telegramStartTimer = null;
let telegramStartInProgress = false;
let telegramStarted = false;
let telegramStartRequiresManualRepair = false;
let whatsappAuthPath = null;

function scheduleReconnect(callbacks) {
    if (isShuttingDown || reconnectTimer) return;

    isReconnecting = true;
    log("[WhatsApp] Reconnecting in 5 seconds...");
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        isReconnecting = false;
        initializeWhatsApp(callbacks);
    }, 5000);
}

function clearTelegramStartRetry() {
    if (telegramStartTimer) {
        clearTimeout(telegramStartTimer);
        telegramStartTimer = null;
    }
}

function scheduleTelegramStartRetry(client, callbacks) {
    if (
        isShuttingDown ||
        whatsappClient !== client ||
        !whatsappGroupChat ||
        telegramStarted ||
        telegramStartRequiresManualRepair ||
        telegramStartTimer
    ) return;

    log("[Telegram] Retrying Telegram startup in 15 seconds...");
    telegramStartTimer = setTimeout(() => {
        telegramStartTimer = null;
        if (isShuttingDown || whatsappClient !== client || !whatsappGroupChat) return;
        void startTelegramWithRecovery(client, callbacks);
    }, 15_000);
}

async function startTelegramWithRecovery(client, callbacks) {
    if (
        isShuttingDown ||
        whatsappClient !== client ||
        !whatsappGroupChat ||
        telegramStarted ||
        telegramStartInProgress ||
        telegramStartRequiresManualRepair
    ) return;

    telegramStartInProgress = true;
    try {
        await onReady(callbacks);
        // Telegram is independent from WhatsApp after authentication. Even if WhatsApp
        // disconnects during startup, a successful Telegram start must not be repeated.
        telegramStarted = true;
        clearTelegramStartRetry();
        log("[Telegram] Startup completed.");
    } catch (err) {
        if (err && err.retryable === false) {
            telegramStartRequiresManualRepair = true;
            clearTelegramStartRetry();
            log("[Telegram] Startup cannot be retried automatically; repair the saved configuration/state and restart: " + (err.message || err));
            return;
        }
        log("[Telegram] Startup failed: " + (err.message || err));
        scheduleTelegramStartRetry(client, callbacks);
    } finally {
        telegramStartInProgress = false;
        if (!telegramStarted && !telegramStartRequiresManualRepair && !isShuttingDown &&
            whatsappClient && whatsappGroupChat && !telegramStartTimer) {
            scheduleTelegramStartRetry(whatsappClient, callbacks);
        }
    }
}

function scheduleGroupResolutionRetry(client, callbacks, reason = "destination group not yet resolved") {
    if (isShuttingDown || whatsappClient !== client || whatsappGroupChat || groupResolutionTimer) return;

    // WhatsApp can report READY before all chats have synchronized. Retry lookup on the
    // existing session instead of staying connected forever with no destination selected.
    log(`[WhatsApp] Destination-group lookup retry scheduled | group=${JSON.stringify(TARGET_WHATSAPP_GROUP)} | retry_in_ms=60000 | reason=${reason}`, "WARN");
    groupResolutionTimer = setTimeout(async () => {
        groupResolutionTimer = null;
        if (isShuttingDown || whatsappClient !== client || whatsappGroupChat) return;

        try {
            const chats = await client.getChats();
            if (whatsappClient !== client || isShuttingDown) return;

            whatsappGroupChat = findUniqueTargetGroup(chats, TARGET_WHATSAPP_GROUP);
            if (!whatsappGroupChat) {
                const matches = Array.isArray(chats)
                    ? chats.filter(chat => chat && chat.isGroup === true && chat.name === TARGET_WHATSAPP_GROUP)
                    : [];
                const status = matches.length > 1
                    ? "still ambiguous (" + matches.length + " exact matches)"
                    : "still not found";
                log("[WhatsApp] Destination-group lookup unresolved on retry | status=" + status + " | group=" + JSON.stringify(TARGET_WHATSAPP_GROUP), "WARN");
                scheduleGroupResolutionRetry(client, callbacks, status);
                return;
            }

            log("[WhatsApp] Target group located after retry: " + whatsappGroupChat.name);
            void startTelegramWithRecovery(client, callbacks);
        } catch (err) {
            log("[WhatsApp] Destination-group retry failed | error=" + (err && err.stack ? err.stack : String(err)), "ERROR");
            scheduleGroupResolutionRetry(client, callbacks, "chat list retry failed");
        }
    }, 60_000);
}

function initializeWhatsApp(callbacks) {
    if (isShuttingDown) {
        log("[WhatsApp] Shutdown is in progress; skipping initialization.");
        return;
    }
    if (whatsappClient || isReconnecting) {
        log("[WhatsApp] Client is already initialized or initializing; skipping duplicate initialization.");
        return;
    }

    isReconnecting = true;
    log("[System] Initializing WhatsApp Client...");

    try {
        const auth = prepareWhatsAppAuthPath();
        whatsappAuthPath = auth.path;
        if (auth.migrated) {
            log("[WhatsApp] Migrated legacy authentication data to the persistent data directory.");
        }
    } catch (err) {
        log("[WhatsApp] Could not prepare authentication storage: " + (err.message || err));
        scheduleReconnect(callbacks);
        return;
    }

    let client;
    try {
        client = new Client({
            authStrategy: new LocalAuth({ dataPath: whatsappAuthPath }),
            puppeteer: {
                headless: true,
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--disable-site-isolation-trials",
                    "--disable-features=IsolateOrigins",
                ],
            },
        });
    } catch (err) {
        log("[WhatsApp] Could not create client: " + (err.message || err));
        scheduleReconnect(callbacks);
        return;
    }

    whatsappClient = client;

    client.on("qr", qr => {
        const qrcode = require("qrcode-terminal");
        qrcode.generate(qr, { small: true });
    });

    client.on("ready", async () => {
        if (whatsappClient !== client || isShuttingDown) return;
        isReconnecting = false;
        log("[WhatsApp] Session ready; loading chat list and resolving the exact destination group.");

        try {
            const chats = await client.getChats();
            if (whatsappClient !== client || isShuttingDown) return;
            log(`[WhatsApp] Chat list loaded | chats_total=${Array.isArray(chats) ? chats.length : "unknown"} | destination_group=${JSON.stringify(TARGET_WHATSAPP_GROUP)} | action=resolve-exact-match`);

            whatsappGroupChat = findUniqueTargetGroup(chats, TARGET_WHATSAPP_GROUP);
            if (!whatsappGroupChat) {
                const matches = Array.isArray(chats)
                    ? chats.filter(chat => chat && chat.isGroup === true && chat.name === TARGET_WHATSAPP_GROUP)
                    : [];
                const status = matches.length > 1
                    ? "ambiguous (" + matches.length + " exact matches)"
                    : "not found";
                log("[WhatsApp] Destination-group lookup unresolved | status=" + status + " | group=" + JSON.stringify(TARGET_WHATSAPP_GROUP), "WARN");
                scheduleGroupResolutionRetry(client, callbacks, status);
                return;
            }

            if (groupResolutionTimer) {
                clearTimeout(groupResolutionTimer);
                groupResolutionTimer = null;
            }
            log(`[WhatsApp] Destination group resolved | group=${JSON.stringify(whatsappGroupChat.name)} | chat_id=${whatsappGroupChat.id && whatsappGroupChat.id._serialized ? whatsappGroupChat.id._serialized : "unknown"} | action=start-Telegram`);
            void startTelegramWithRecovery(client, callbacks);
        } catch (err) {
            log("[WhatsApp] Chat-list retrieval failed while resolving destination group | " + (err && err.stack ? err.stack : String(err)), "ERROR");
            scheduleGroupResolutionRetry(client, callbacks, "client.getChats() failed");
        }
    });

    client.on("disconnected", async reason => {
        // Ignore stale events from a client that has already been replaced or shut down.
        if (whatsappClient !== client) return;

        log("[WhatsApp] Disconnected: " + reason);
        if (groupResolutionTimer) {
            clearTimeout(groupResolutionTimer);
            groupResolutionTimer = null;
        }
        clearTelegramStartRetry();
        isReconnecting = true;
        whatsappGroupChat = null;
        whatsappClient = null;

        try {
            await client.destroy();
        } catch (err) {
            log("[WhatsApp] Error during destroy: " + (err.message || err));
        }

        if (isShuttingDown) {
            isReconnecting = false;
            return;
        }

        if (reason === "LOGOUT") {
            log("[WhatsApp] Cleaning auth session due to LOGOUT...");
            const authPath = whatsappAuthPath;
            if (authPath && fs.existsSync(authPath)) {
                try {
                    fs.rmSync(authPath, { recursive: true, force: true });
                } catch (err) {
                    log("[WhatsApp] Could not remove logged-out auth data: " + (err.message || err));
                }
            }
        }

        scheduleReconnect(callbacks);
    });

    // initialize() can reject without emitting "disconnected"; handle that failure too.
    Promise.resolve()
        .then(() => client.initialize())
        .catch(async err => {
            if (whatsappClient !== client) return;

            log("[WhatsApp] Initialization failed: " + (err.message || err));
            whatsappClient = null;
            whatsappGroupChat = null;
            isReconnecting = true;
            try {
                await client.destroy();
            } catch (destroyError) {
                log("[WhatsApp] Error cleaning up failed initialization: " + (destroyError.message || destroyError));
            }
            scheduleReconnect(callbacks);
        });
}

async function sendAlert(source, target, estimated_time) {
    if (!whatsappGroupChat) {
        log("[WhatsApp] Cannot send alert - group not connected.");
        return null;
    }

    if (!WHATSAPP_INVITE_LINK) {
        log("[WhatsApp] Cannot send alert - WHATSAPP_INVITE_LINK is not configured.");
        return null;
    }

    const alertMsg =
        "🚨 *צבע אדום* 🚨\n\n" +
        "זירה: " + (source || "לא מאומת") + "\n" +
        "מרחב: " + (target || "לא מאומת") + "\n" +
        "זמן: " + (estimated_time || "לא ידוע") + "\n\n" +
        "הצטרפו: " + WHATSAPP_INVITE_LINK;

    try {
        await whatsappGroupChat.sendMessage(alertMsg);
        log(`[WhatsApp][Delivery] New alert sent | group=${JSON.stringify(whatsappGroupChat.name)} | source=${JSON.stringify(source || "UNVERIFIED")} | target=${JSON.stringify(target || "UNVERIFIED")} | estimated_time=${JSON.stringify(estimated_time || "UNKNOWN")} | message_chars=${alertMsg.length}`);
        return { source, target, estimated_time, publishedAt: Date.now() };
    } catch (err) {
        log(`[WhatsApp][Delivery] New alert failed | group=${JSON.stringify(whatsappGroupChat && whatsappGroupChat.name || "unavailable")} | source=${JSON.stringify(source || "UNVERIFIED")} | target=${JSON.stringify(target || "UNVERIFIED")} | error=${err && err.stack ? err.stack : String(err)}`, "ERROR");
        return null;
    }
}

async function sendUpdate(updatedFields, prevPublished, updateType) {
    if (!whatsappGroupChat) {
        log("[WhatsApp] Cannot send update - group not connected.");
        return null;
    }

    const updateLabel = {
        source: "עדכון זירת השיגור",
        target: "עדכון אזורים",
        time: "עדכון זמן",
        "source+target": "עדכון פרטים",
        "source+time": "עדכון פרטים",
        "target+time": "עדכון פרטים",
        "source+target+time": "עדכון פרטים",
    }[updateType] || "עדכון";

    const alertMsg =
        "🔄 *" + updateLabel + "* 🔄\n\n" +
        "זירה: " + (updatedFields.source || prevPublished.source || "לא מאומת") + "\n" +
        "מרחב: " + (updatedFields.target || prevPublished.target || "לא מאומת") + "\n" +
        "זמן: " + (updatedFields.estimated_time || prevPublished.estimated_time || "לא ידוע") + "\n\n" +
        "הצטרפו: " + WHATSAPP_INVITE_LINK;

    try {
        await whatsappGroupChat.sendMessage(alertMsg);
        const resultingFields = {
            source: updatedFields.source || prevPublished.source || "",
            target: updatedFields.target || prevPublished.target || "",
            estimated_time: updatedFields.estimated_time || prevPublished.estimated_time || "",
            publishedAt: Date.now(),
        };
        log(`[WhatsApp][Delivery] Update sent | group=${JSON.stringify(whatsappGroupChat.name)} | update_type=${updateType} | changed_fields={source:${JSON.stringify(updatedFields.source && updatedFields.source !== prevPublished.source ? updatedFields.source : "unchanged")}, target:${JSON.stringify(updatedFields.target && updatedFields.target !== prevPublished.target ? updatedFields.target : "unchanged")}, estimated_time:${JSON.stringify(updatedFields.estimated_time && updatedFields.estimated_time !== prevPublished.estimated_time ? updatedFields.estimated_time : "unchanged")}} | resulting_fields={source:${JSON.stringify(resultingFields.source || "UNVERIFIED")}, target:${JSON.stringify(resultingFields.target || "UNVERIFIED")}, estimated_time:${JSON.stringify(resultingFields.estimated_time || "UNKNOWN")}} | message_chars=${alertMsg.length}`);
        return resultingFields;
    } catch (err) {
        log(`[WhatsApp][Delivery] Update failed | group=${JSON.stringify(whatsappGroupChat && whatsappGroupChat.name || "unavailable")} | update_type=${updateType} | error=${err && err.stack ? err.stack : String(err)}`, "ERROR");
        return null;
    }
}

async function shutdownWhatsApp() {
    isShuttingDown = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (groupResolutionTimer) {
        clearTimeout(groupResolutionTimer);
        groupResolutionTimer = null;
    }
    clearTelegramStartRetry();

    const client = whatsappClient;
    whatsappClient = null;
    whatsappGroupChat = null;
    isReconnecting = false;

    if (client) {
        try {
            await client.destroy();
        } catch (err) {
            log("[WhatsApp] Error shutting down: " + (err.message || err));
        }
    }
}

module.exports = { initializeWhatsApp, sendAlert, sendUpdate, shutdownWhatsApp };
