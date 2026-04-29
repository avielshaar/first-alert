/**
 * WhatsApp Client Module
 */

const { Client, LocalAuth } = require("whatsapp-web.js");
const { log } = require("../logger");
const { TARGET_WHATSAPP_GROUP } = require("../config");
const { onReady } = require("./handlers/ready");

let whatsappGroupChat = null;
let whatsappClient    = null;

function initializeWhatsApp(callbacks) {
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
        log("[WhatsApp] ✅ Connected and ready!");
        try {
            const chats = await whatsappClient.getChats();
            whatsappGroupChat = chats.find(c => c.isGroup && c.name.includes(TARGET_WHATSAPP_GROUP));
            if (!whatsappGroupChat) {
                log(`[WhatsApp] ❌ Target group not found: ${TARGET_WHATSAPP_GROUP}`);
                return;
            }
            log(`[WhatsApp] ✅ Target group located: ${whatsappGroupChat.name}`);
            await onReady(callbacks);
        } catch (err) {
            log("[WhatsApp] ❌ Error fetching chats: " + err);
        }
    });

    whatsappClient.initialize();
}

/**
 * שליחת התרעה חדשה
 */
async function sendAlert(source, target, estimated_time) {
    const alertMsg =
        `🚨 *התרעה - שיגורים בדרכם!* 🚨\n\n` +
        `📍 *מקור:* ${source          || "לא ידוע"}\n` +
        `🎯 *יעד:* ${target            || "לא ידוע"}\n` +
        `⏱️ *זמן משוער:* ${estimated_time || "לא ידוע"}\n\n` +
        `⏱️ *להצטרפות להתרעות לפני פיקוד העורף:* https://chat.whatsapp.com/GuyC5q1jjOc3cKTJj3gYn6?mode=gi_t`;

    try {
        await whatsappGroupChat.sendMessage(alertMsg);
        log("[WhatsApp] 📤 Alert sent!");
        return { source, target, estimated_time, publishedAt: Date.now() };
    } catch (err) {
        log("[WhatsApp] ❌ Failed to send: " + err);
        return null;
    }
}

/**
 * שליחת עדכון לאירוע קיים
 * 
 * @param {object} updatedFields - השדות המעודכנים { source, target, estimated_time }
 * @param {object} prevPublished - מה היה לפני
 * @param {string} updateType    - "target" | "time" | "target+time"
 */
async function sendUpdate(updatedFields, prevPublished, updateType) {
    const updateLabel = {
        "target":      "אזור יעד",
        "time":        "זמן הגעה",
        "target+time": "אזור יעד וזמן הגעה",
    }[updateType] || "פרטים";

    const alertMsg =
        `🔄 *התרעה - עדכון ${updateLabel}* 🔄\n\n` +
        `📍 *מקור:* ${updatedFields.source          || prevPublished.source || "לא ידוע"}\n` +
        `🎯 *יעד:* ${updatedFields.target            || prevPublished.target || "לא ידוע"}\n` +
        `⏱️ *זמן משוער:* ${updatedFields.estimated_time || prevPublished.estimated_time || "לא ידוע"}\n\n` +
        `⏱️ *להצטרפות להתרעות לפני פיקוד העורף:* https://chat.whatsapp.com/GuyC5q1jjOc3cKTJj3gYn6?mode=gi_t`;

    try {
        await whatsappGroupChat.sendMessage(alertMsg);
        log("[WhatsApp] 📤 Update sent!");
        return {
            source:         updatedFields.source          || prevPublished.source,
            target:         updatedFields.target          || prevPublished.target,
            estimated_time: updatedFields.estimated_time  || prevPublished.estimated_time,
            publishedAt:    Date.now(),
        };
    } catch (err) {
        log("[WhatsApp] ❌ Failed to send update: " + err);
        return null;
    }
}

async function shutdownWhatsApp() {
    if (whatsappClient) await whatsappClient.destroy();
}

module.exports = { initializeWhatsApp, sendAlert, sendUpdate, shutdownWhatsApp };