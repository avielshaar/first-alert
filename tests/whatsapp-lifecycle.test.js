const { EventEmitter } = require("node:events");

describe("WhatsApp lifecycle recovery", () => {
    let MockClient;
    let client;
    let onReady;
    let whatsapp;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules();
        onReady = jest.fn();
        client = null;

        MockClient = class extends EventEmitter {
            constructor() {
                super();
                this.initialize = jest.fn().mockResolvedValue(undefined);
                this.destroy = jest.fn().mockResolvedValue(undefined);
                this.getChats = jest.fn();
                client = this;
            }
        };

        jest.doMock("whatsapp-web.js", () => ({
            Client: MockClient,
            LocalAuth: class {
                constructor(options) { this.options = options; }
            },
        }));
        jest.doMock("../src/clients/handlers/ready", () => ({ onReady }));
        jest.doMock("../src/clients/whatsapp-helpers", () => ({
            prepareWhatsAppAuthPath: () => ({ path: "/tmp/first-alert-test-auth", migrated: false }),
            findUniqueTargetGroup: (chats, targetName) => {
                if (!Array.isArray(chats) || !targetName) return null;
                const matches = chats.filter(chat => chat && chat.isGroup === true && chat.name === targetName);
                return matches.length === 1 ? matches[0] : null;
            },
        }));

        process.env.TELEGRAM_API_ID = "12345";
        process.env.TELEGRAM_API_HASH = "test-hash";
        process.env.ALERT_CHANNELS = "-1001,-1002";
        process.env.GEMINI_API_KEY = "test-key";
        process.env.WHATSAPP_GROUPS = "Alert Group";
        process.env.WHATSAPP_INVITE_LINK = "https://chat.whatsapp.com/test";
        whatsapp = require("../src/clients/whatsapp");
    });

    afterEach(async () => {
        if (whatsapp) await whatsapp.shutdownWhatsApp();
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.resetModules();
        jest.dontMock("whatsapp-web.js");
        jest.dontMock("../src/clients/handlers/ready");
        jest.dontMock("../src/clients/whatsapp-helpers");
    });

    async function start() {
        whatsapp.initializeWhatsApp({});
        await jest.advanceTimersByTimeAsync(0);
        expect(client).not.toBeNull();
    }

    test("retries exact target-group discovery when chats have not synchronized yet", async () => {
        const target = { isGroup: true, name: "Alert Group" };
        await start();
        // Return no chats at first, then the exact group during the retry.
        client.getChats
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([target]);

        client.emit("ready");
        await jest.advanceTimersByTimeAsync(0);
        expect(onReady).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(60_000);
        expect(onReady).toHaveBeenCalledTimes(1);
    });

    test("retries Telegram startup separately after WhatsApp already found its group", async () => {
        const target = { isGroup: true, name: "Alert Group" };
        await start();
        client.getChats.mockResolvedValue([target]);
        onReady.mockRejectedValueOnce(new Error("temporary Telegram connection failure"))
            .mockResolvedValueOnce(undefined);

        client.emit("ready");
        await jest.advanceTimersByTimeAsync(0);
        expect(onReady).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(15_000);
        expect(onReady).toHaveBeenCalledTimes(2);
    });
});
