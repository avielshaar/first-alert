/**
 * WhatsApp Client Module
 */
const { Client, LocalAuth } = require("whatsapp-web.js");
const fs = require("fs");
const path = require("path");
const { log } = require("../utils/logger");
const { TARGET_WHATSAPP_GROUP, WHATSAPP_INVITE_LINK } = require("../config");
const { onReady } = require("./handlers/ready");

let whatsappGroupChat = null;
let whatsappClient    = null;
let isReconnecting    = false;

function initializeWhatsApp(callbacks) {
    if (isReconnecting) return;
    log("[System] Initializing WhatsApp Client...");

    whatsappClient = new Client({
        authStrategy: new LocalAuth({ dataPath: "./.wwebjs_auth" }),
        puppeteer: {
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-site-isolation-trials",
                "--disable-features=IsolateOrigins"
            ],
        }
    });

    whatsappClient.on("qr", (qr) => {
        const qrcode = require("qrcode-terminal");
        qrcode.generate(qr, { small: true });
    });

    whatsappClient.on("ready", async () => {
        isReconnecting = false;
        log("[WhatsApp]   Connected and ready!");
        try {
            const chats = await whatsappClient.getChats();
            whatsappGroupChat = chats.find(c => c.isGroup && c.name === TARGET_WHATSAPP_GROUP);

            if (!whatsappGroupChat) {
                log(`[WhatsApp]   Target group not found: ${TARGET_WHATSAPP_GROUP}`);
                return;
            }
            log(`[WhatsApp]   Target group located: ${whatsappGroupChat.name}`);
            await onReady(callbacks);
        } catch (err) {
            log("[WhatsApp]   Error fetching chats: " + (err?.stack || String(err)));
        }
    });

    whatsappClient.on("disconnected", async (reason) => {
        log(`[WhatsApp] ⚠️ Disconnected: ${reason}`);
        whatsappGroupChat = null;

        try {
            await whatsappClient.destroy();
        } catch (err) {
            log("[WhatsApp] Error during destroy: " + err.message);
        }

        // מחיקת קבצי הסשן במקרה של ניתוק/יציאה מהחשבון כדי למנוע קריסה בהתחברות הבאה
        if (reason === "LOGOUT") {
            log("[WhatsApp] Cleaning auth session due to LOGOUT...");
            const authPath = path.join(process.cwd(), ".wwebjs_auth");
            if (fs.existsSync(authPath)) {
                fs.rmSync(authPath, { recursive: true, force: true });
            }
        }

        log("[WhatsApp] Reconnecting in 5 seconds...");
        setTimeout(() => {
            isReconnecting = false;
            initializeWhatsApp(callbacks);
        }, 5000);
    });

    whatsappClient.initialize();
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
        `🚨 *צבע אדום* 🚨\n\n` +
        `זירה: ${source          || "לא ידוע"}\n` +
        `מרחב: ${target            || "לא ידוע"}\n` +
        `זמן: ${estimated_time || "לא ידוע"}\n\n` +
        `הצטרפו: ${WHATSAPP_INVITE_LINK}`;

    try {
        await whatsappGroupChat.sendMessage(alertMsg);
        log("[WhatsApp]   Alert sent successfully!");
        return { source, target, estimated_time, publishedAt: Date.now() };
    } catch (err) {
        log("[WhatsApp]   Failed to send alert: " + err);
        return null;
    }
}

async function sendUpdate(updatedFields, prevPublished, updateType) {
    if (!whatsappGroupChat) {
        log("[WhatsApp] Cannot send update - group not connected.");
        return null;
    }

    const updateLabel = {
        "target":      "עדכון אזורים",
        "time":        "עדכון זמן",
        "target+time": "עדכון פרטים"
    }[updateType] || "עדכון";

    const alertMsg =
        `🔄 *${updateLabel}* 🔄\n\n` +
        `זירה: ${updatedFields.source          || prevPublished.source || "לא ידוע"}\n` +
        `מרחב: ${updatedFields.target            || prevPublished.target || "לא ידוע"}\n` +
        `זמן: ${updatedFields.estimated_time || prevPublished.estimated_time || "לא ידוע"}\n\n` +
        `הצטרפו: ${WHATSAPP_INVITE_LINK}`;

    try {
        await whatsappGroupChat.sendMessage(alertMsg);
        log("[WhatsApp]   Update sent successfully!");
        return {
            source:         updatedFields.source          || prevPublished.source,
            target:         updatedFields.target          || prevPublished.target,
            estimated_time: updatedFields.estimated_time  || prevPublished.estimated_time,
            publishedAt:    Date.now(),
        };
    } catch (err) {
        log("[WhatsApp]   Failed to send update: " + err);
        return null;
    }
}

async function shutdownWhatsApp() {
    if (whatsappClient) {
        try {
            await whatsappClient.destroy();
        } catch (err) {
            log("[WhatsApp] Error shutting down: " + err.message);
        }
    }
}

module.exports = { initializeWhatsApp, sendAlert, sendUpdate, shutdownWhatsApp };