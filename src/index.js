const { log } = require("./utils/logger");
const { initializeWhatsApp, sendAlert, sendUpdate, shutdownWhatsApp } = require("./clients/whatsapp");
const { shutdownTelegram } = require("./clients/telegram");
const { setLastPublished } = require("./messaging/processor");

const callbacks = {
    async alert(source, target, estimated_time) {
        const result = await sendAlert(source, target, estimated_time);
        if (result) setLastPublished(result.source, result.target, result.estimated_time);
    },
    async update(updatedFields, prevPublished, updateType) {
        const result = await sendUpdate(updatedFields, prevPublished, updateType);
        if (result) setLastPublished(result.source, result.target, result.estimated_time);
    },
};

initializeWhatsApp(callbacks);

process.on('SIGINT', async () => {
    log("\n[System] Shutting down...");
    await shutdownWhatsApp();
    await shutdownTelegram();
    process.exit(0);
});