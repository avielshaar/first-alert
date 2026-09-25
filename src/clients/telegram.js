/**
 * Telegram Client Module
 */

const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const { log } = require("../utils/logger");
const { TELEGRAM_API_ID, TELEGRAM_API_HASH, ALERT_CHANNELS } = require("../config");
const { processMessage } = require("../messaging/processor");

let telegramClient = null;
const lastSeenMessageIds = {};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function startTelegramClient(callbacks) {
    log("[Telegram] Initializing client...");

    const sessionFile = './.telegram_session';
    let sessionString = '';
    if (fs.existsSync(sessionFile)) sessionString = fs.readFileSync(sessionFile, 'utf8');

    const stringSession = new StringSession(sessionString);
    telegramClient = new TelegramClient(stringSession, TELEGRAM_API_ID, TELEGRAM_API_HASH, {
        connectionRetries: 5,
    });

    await telegramClient.start({
        phoneNumber: async () => await input.text("[Telegram Auth] Enter your phone number: "),
        password:    async () => await input.text("[Telegram Auth] Enter your 2FA password: "),
        phoneCode:   async () => await input.text("[Telegram Auth] Enter the code: "),
        onError:     (err) => log("[Telegram Auth] Error: " + err),
    });

    fs.writeFileSync(sessionFile, telegramClient.session.save());
    log("[Telegram] ✅ Connected successfully!");

    log("[Telegram] 🔍 Initializing trackers...");
    for (let id of ALERT_CHANNELS) {
        if (!id) continue;
        try {
            const msgs = await telegramClient.getMessages(id, { limit: 1 });
            if (msgs && msgs.length > 0) {
                lastSeenMessageIds[id] = msgs[0].id;
                log(`✅ Tracking initialized for ID: ${id}`);
            }
        } catch (err) {
            log(`❌ Could not fetch initial data for ${id}`);
        }
        await sleep(300);
    }

    log("[Telegram] 🔍 Listening for new messages...");
    startPolling(callbacks);
}

async function startPolling(callbacks) {
    (async () => {
        while (true) {
            for (let id of ALERT_CHANNELS) {
                if (!id) continue;
                try {
                    const msgs = await telegramClient.getMessages(id, { limit: 1 });
                    if (msgs && msgs.length > 0) {
                        const latestMsg = msgs[0];
                        const msgText   = latestMsg.message;

                        if (latestMsg.id > (lastSeenMessageIds[id] || 0)) {
                            lastSeenMessageIds[id] = latestMsg.id;
                            if (msgText) {
                                log(`[POLLING] 🚨 NEW MESSAGE | Channel: ${id}`);
                                await processMessage(id, msgText, callbacks);
                            }
                        }
                    }
                } catch (err) {
                    if (err.message && err.message.includes("FLOOD")) await sleep(5000);
                }
                await sleep(300);
            }
            await sleep(1000);
        }
    })();
}

async function shutdownTelegram() {
    if (telegramClient) await telegramClient.disconnect();
}

module.exports = { startTelegramClient, shutdownTelegram };