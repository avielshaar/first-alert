const { log } = require("./utils/logger");
const { validateConfig } = require("./config");

const configErrors = validateConfig();
if (configErrors.length > 0) {
    log("[Config] Startup aborted because configuration is incomplete or invalid:");
    for (const error of configErrors) log("[Config] " + error);
    process.exit(1);
}

const { initializeWhatsApp, sendAlert, sendUpdate, shutdownWhatsApp } = require("./clients/whatsapp");
const { shutdownTelegram } = require("./clients/telegram");
const { setLastPublished } = require("./messaging/processor");

const callbacks = {
    async alert(source, target, estimated_time) {
        const result = await sendAlert(source, target, estimated_time);
        if (!result) return false;
        setLastPublished(result.source, result.target, result.estimated_time);
        return true;
    },
    async update(updatedFields, prevPublished, updateType) {
        const result = await sendUpdate(updatedFields, prevPublished, updateType);
        if (!result) return false;
        setLastPublished(result.source, result.target, result.estimated_time);
        return true;
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
