const { EventEmitter } = require("node:events");

const INVITE_LINK = "https://chat.whatsapp.com/test-invite";
const FIXED_TIME = 1_800_000_000_000;

describe("WhatsApp delivery contract", () => {
    let MockClient;
    let client;
    let targetGroup;
    let onReady;
    let whatsapp;
    let originalEnv;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules();
        jest.restoreAllMocks();

        originalEnv = {};
        for (const key of [
            "TELEGRAM_API_ID",
            "TELEGRAM_API_HASH",
            "ALERT_CHANNELS",
            "TEST_CHANNELS",
            "GEMINI_API_KEY",
            "WHATSAPP_GROUPS",
            "WHATSAPP_INVITE_LINK",
        ]) {
            originalEnv[key] = process.env[key];
        }

        process.env.TELEGRAM_API_ID = "12345";
        process.env.TELEGRAM_API_HASH = "test-hash";
        process.env.ALERT_CHANNELS = "-1001,-1002";
        process.env.TEST_CHANNELS = "";
        process.env.GEMINI_API_KEY = "test-key";
        process.env.WHATSAPP_GROUPS = "Alert Group";
        process.env.WHATSAPP_INVITE_LINK = INVITE_LINK;

        onReady = jest.fn().mockResolvedValue(undefined);
        targetGroup = {
            isGroup: true,
            name: "Alert Group",
            id: { _serialized: "test-group-id@g.us" },
            sendMessage: jest.fn().mockResolvedValue({
                id: { _serialized: "test-message-id" },
            }),
        };
        client = null;

        MockClient = class extends EventEmitter {
            constructor() {
                super();
                this.initialize = jest.fn().mockResolvedValue(undefined);
                this.destroy = jest.fn().mockResolvedValue(undefined);
                this.getChats = jest.fn().mockResolvedValue([targetGroup]);
                client = this;
            }
        };

        jest.doMock("whatsapp-web.js", () => ({
            Client: MockClient,
            LocalAuth: class {
                constructor(options) {
                    this.options = options;
                }
            },
        }));
        jest.doMock("../src/clients/handlers/ready", () => ({ onReady }));
        jest.doMock("../src/clients/whatsapp-helpers", () => ({
            prepareWhatsAppAuthPath: () => ({
                path: "/tmp/first-alert-delivery-test-auth",
                migrated: false,
            }),
            findUniqueTargetGroup: (chats, targetName) => {
                if (!Array.isArray(chats) || !targetName) return null;
                const matches = chats.filter(chat =>
                    chat && chat.isGroup === true && chat.name === targetName
                );
                return matches.length === 1 ? matches[0] : null;
            },
        }));
        jest.doMock("../src/utils/logger", () => ({ log: jest.fn() }));

        whatsapp = require("../src/clients/whatsapp");
    });

    afterEach(async () => {
        if (whatsapp) await whatsapp.shutdownWhatsApp();

        jest.clearAllTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
        jest.resetModules();
        jest.dontMock("whatsapp-web.js");
        jest.dontMock("../src/clients/handlers/ready");
        jest.dontMock("../src/clients/whatsapp-helpers");
        jest.dontMock("../src/utils/logger");

        for (const [key, value] of Object.entries(originalEnv || {})) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    async function connectToTargetGroup() {
        whatsapp.initializeWhatsApp({});
        await jest.advanceTimersByTimeAsync(0);
        expect(client).not.toBeNull();

        client.emit("ready");
        await jest.advanceTimersByTimeAsync(0);

        expect(onReady).toHaveBeenCalledTimes(1);
    }

    test("does not attempt delivery when the destination group is not connected", async () => {
        await expect(whatsapp.sendAlert("ישראל", "מרכז", "20:30")).resolves.toBeNull();
        await expect(whatsapp.sendUpdate(
            { source: "ישראל", target: "מרכז", estimated_time: "20:30" },
            { source: "ישראל", target: "מרכז", estimated_time: "20:30" },
            "time"
        )).resolves.toBeNull();

        expect(targetGroup.sendMessage).not.toHaveBeenCalled();
    });

    test("sends the exact new-alert text and returns a publication result", async () => {
        jest.spyOn(Date, "now").mockReturnValue(FIXED_TIME);
        await connectToTargetGroup();

        await expect(whatsapp.sendAlert("ישראל", "מרכז", "20:30")).resolves.toEqual({
            source: "ישראל",
            target: "מרכז",
            estimated_time: "20:30",
            publishedAt: FIXED_TIME,
        });

        expect(targetGroup.sendMessage).toHaveBeenCalledTimes(1);
        expect(targetGroup.sendMessage).toHaveBeenCalledWith(
            "🚨 *צבע אדום* 🚨\n\n" +
            "זירה: ישראל\n" +
            "מרחב: מרכז\n" +
            "זמן: 20:30\n\n" +
            "הצטרפו: " + INVITE_LINK
        );
    });

    test("uses safe fallback text for missing alert fields", async () => {
        await connectToTargetGroup();

        const result = await whatsapp.sendAlert("", null, undefined);

        expect(result).toEqual(expect.objectContaining({
            source: "",
            target: null,
            estimated_time: undefined,
        }));
        expect(targetGroup.sendMessage).toHaveBeenCalledWith(
            "🚨 *צבע אדום* 🚨\n\n" +
            "זירה: לא מאומת\n" +
            "מרחב: לא מאומת\n" +
            "זמן: לא ידוע\n\n" +
            "הצטרפו: " + INVITE_LINK
        );
    });

    test("does not send a new alert when the invite link is absent", async () => {
        process.env.WHATSAPP_INVITE_LINK = "";
        jest.resetModules();
        whatsapp = require("../src/clients/whatsapp");

        await connectToTargetGroup();

        await expect(whatsapp.sendAlert("ישראל", "מרכז", "20:30")).resolves.toBeNull();
        expect(targetGroup.sendMessage).not.toHaveBeenCalled();
    });

    test("returns null when sending a new alert rejects", async () => {
        await connectToTargetGroup();
        targetGroup.sendMessage.mockRejectedValueOnce(new Error("simulated WhatsApp send failure"));

        await expect(whatsapp.sendAlert("ישראל", "מרכז", "20:30")).resolves.toBeNull();
        expect(targetGroup.sendMessage).toHaveBeenCalledTimes(1);
    });

    test.each([
        ["source", "עדכון זירת השיגור"],
        ["target", "עדכון אזורים"],
        ["time", "עדכון זמן"],
        ["source+target", "עדכון פרטים"],
        ["source+time", "עדכון פרטים"],
        ["target+time", "עדכון פרטים"],
        ["source+target+time", "עדכון פרטים"],
        ["unknown", "עדכון"],
    ])("formats update type %s with the expected label", async (updateType, expectedLabel) => {
        await connectToTargetGroup();

        const previous = {
            source: "מקור קודם",
            target: "אזור קודם",
            estimated_time: "20:00",
        };
        const updated = {
            source: "ישראל",
            target: "מרכז",
            estimated_time: "20:30",
        };

        const result = await whatsapp.sendUpdate(updated, previous, updateType);

        expect(result).toEqual(expect.objectContaining({
            source: "ישראל",
            target: "מרכז",
            estimated_time: "20:30",
        }));
        expect(result.publishedAt).toEqual(expect.any(Number));
        expect(targetGroup.sendMessage).toHaveBeenCalledWith(
            "🔄 *" + expectedLabel + "* 🔄\n\n" +
            "זירה: ישראל\n" +
            "מרחב: מרכז\n" +
            "זמן: 20:30\n\n" +
            "הצטרפו: " + INVITE_LINK
        );
    });

    test("preserves prior values for fields not present in a partial update", async () => {
        await connectToTargetGroup();

        const previous = {
            source: "ישראל",
            target: "מרכז",
            estimated_time: "20:00",
        };
        const result = await whatsapp.sendUpdate(
            { source: "", target: "דרום", estimated_time: "" },
            previous,
            "target"
        );

        expect(result).toEqual(expect.objectContaining({
            source: "ישראל",
            target: "דרום",
            estimated_time: "20:00",
        }));
        expect(targetGroup.sendMessage).toHaveBeenCalledWith(
            "🔄 *עדכון אזורים* 🔄\n\n" +
            "זירה: ישראל\n" +
            "מרחב: דרום\n" +
            "זמן: 20:00\n\n" +
            "הצטרפו: " + INVITE_LINK
        );
        expect(previous).toEqual({
            source: "ישראל",
            target: "מרכז",
            estimated_time: "20:00",
        });
    });

    test("returns null when sending an update rejects", async () => {
        await connectToTargetGroup();
        targetGroup.sendMessage.mockRejectedValueOnce(new Error("simulated WhatsApp send failure"));

        await expect(whatsapp.sendUpdate(
            { source: "ישראל", target: "מרכז", estimated_time: "20:30" },
            { source: "ישראל", target: "מרכז", estimated_time: "20:00" },
            "time"
        )).resolves.toBeNull();

        expect(targetGroup.sendMessage).toHaveBeenCalledTimes(1);
    });
});
