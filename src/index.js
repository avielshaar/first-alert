const { log } = require("./utils/logger");
const { validateConfig, ALERT_CHANNELS } = require("./config");

const configErrors = validateConfig();
if (configErrors.length > 0) {
    log("[Config] Startup aborted because configuration is incomplete or invalid:");
    for (const error of configErrors) log("[Config] " + error);
    process.exit(1);
}

log(`[System] Startup validation passed | monitored_channel_count=${ALERT_CHANNELS.length} | channel_ids=[${ALERT_CHANNELS.join(", ")}] | log_time_zone=${process.env.LOG_TIME_ZONE || "Asia/Jerusalem"} | node=${process.version}`);

const { initializeWhatsApp, sendAlert, sendUpdate, shutdownWhatsApp } = require("./clients/whatsapp");
const { shutdownTelegram } = require("./clients/telegram");
const callbacks = {
    // The processor owns the durable publication baseline. It updates that baseline only after
    // delivery succeeds and persists it atomically with the event state.
    async alert(source, target, estimated_time) {
        return Boolean(await sendAlert(source, target, estimated_time));
    },
    async update(updatedFields, prevPublished, updateType) {
        return Boolean(await sendUpdate(updatedFields, prevPublished, updateType));
    },
};

initializeWhatsApp(callbacks);

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[System] Shutting down (${signal})...`);
    try {
        await shutdownWhatsApp();
    } catch (err) {
        log(`[System] WhatsApp shutdown warning: ${err.message || err}`);
    }
    try {
        await shutdownTelegram();
    } catch (err) {
        log(`[System] Telegram shutdown warning: ${err.message || err}`);
    }
    process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
