const { parseChannelIds, validateConfig } = require("../src/config");

describe("configuration validation", () => {
    test("combines alert and test channels while removing blanks and duplicates", () => {
        expect(parseChannelIds(" -1001, -1002, -1001 ", "-1002,, -1003 "))
            .toEqual(["-1001", "-1002", "-1003"]);
    });

    test("accepts a complete valid runtime configuration", () => {
        const env = {
            TELEGRAM_API_ID: "123456",
            TELEGRAM_API_HASH: "telegram-hash",
            ALERT_CHANNELS: "-1001,-1002",
            TEST_CHANNELS: "-1003",
            GEMINI_API_KEY: "gemini-key",
            WHATSAPP_GROUPS: "Exact Alert Group",
            WHATSAPP_INVITE_LINK: "https://chat.whatsapp.com/example",
        };
        expect(validateConfig(env)).toEqual([]);
    });

    test("reports all missing required settings rather than failing later in a client library", () => {
        expect(validateConfig({})).toEqual([
            "TELEGRAM_API_ID must be a positive integer.",
            "TELEGRAM_API_HASH is required.",
            "Configure at least one channel in ALERT_CHANNELS or TEST_CHANNELS.",
            "GEMINI_API_KEY is required.",
            "WHATSAPP_GROUPS must contain the exact target WhatsApp group name.",
            "WHATSAPP_INVITE_LINK is required.",
        ]);
    });

    test.each(["", "abc", "123abc", "-1", "1.5", "9007199254740992"])(
        "rejects invalid Telegram API ID %p",
        apiId => {
            const env = {
                TELEGRAM_API_ID: apiId,
                TELEGRAM_API_HASH: "hash",
                ALERT_CHANNELS: "-1001",
                GEMINI_API_KEY: "key",
                WHATSAPP_GROUPS: "group",
                WHATSAPP_INVITE_LINK: "https://chat.whatsapp.com/example",
            };
            expect(validateConfig(env)).toContain("TELEGRAM_API_ID must be a positive integer.");
        }
    );
});
