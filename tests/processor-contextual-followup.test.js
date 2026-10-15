const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const mockGenerateContent = jest.fn();
jest.mock("@google/genai", () => ({
    GoogleGenAI: jest.fn(() => ({ models: { generateContent: mockGenerateContent } })),
}));

process.env.GEMINI_API_KEY = "test-key";
process.env.FIRST_ALERT_STATE_FILE = path.join(
    os.tmpdir(),
    "first-alert-contextual-guard-" + process.pid + "-" + Date.now() + ".json"
);

const stateFile = process.env.FIRST_ALERT_STATE_FILE;
const { processMessage, setLastPublished, getActiveEvents } = require("../src/messaging/processor");

const callbacks = {
    alert: jest.fn(),
    update: jest.fn(),
};

function clearEvents() {
    for (const key of Object.keys(getActiveEvents())) delete getActiveEvents()[key];
}

function aiResult(category) {
    return { text: JSON.stringify({ category, reasoning: "deterministic integration test" }) };
}

describe("processor contextual region follow-up guard", () => {
    beforeEach(() => {
        mockGenerateContent.mockReset();
        clearEvents();
        setLastPublished(null, null, null);
        callbacks.alert.mockReset().mockResolvedValue(true);
        callbacks.update.mockReset().mockResolvedValue(true);
        mockGenerateContent
            .mockResolvedValueOnce(aiResult("LAUNCH_REPORT"))
            .mockResolvedValueOnce(aiResult("IRRELEVANT"))
            .mockResolvedValueOnce(aiResult("LAUNCH_REPORT"));
    });

    afterAll(() => {
        try { fs.rmSync(stateFile, { force: true }); } catch (_) {}
        try { fs.rmSync(stateFile + ".tmp", { force: true }); } catch (_) {}
    });

    test("unrelated short headlines and blacklisted reports cannot confirm a region", async () => {
        // Channel A reports a source-only launch.
        await processMessage("channel-A", "שיגורים מאיראן", callbacks, 101, 1767254400);

        // Although it mentions a region, this is a generic headline, not a region-only follow-up.
        await processMessage("channel-A", "דיווח במרכז", callbacks, 102, 1767254401);

        // Channel B confirms the source, so the safe initial publication omits the target.
        await processMessage("channel-B", "שיגורים מאיראן", callbacks, 201, 1767254402);

        expect(callbacks.alert).toHaveBeenCalledTimes(1);
        expect(callbacks.alert).toHaveBeenCalledWith("איראן", "", "");

        // A blacklisted report from another channel must not complete the target vote.
        await processMessage("channel-B", "נפגעים במרכז", callbacks, 202, 1767254403);

        expect(callbacks.update).not.toHaveBeenCalled();
        expect(getActiveEvents()["event-1"].target).toBe("");
        expect(getActiveEvents()["event-1"].messages.map(message => message.text))
            .toEqual(["שיגורים מאיראן", "שיגורים מאיראן"]);
    });
});
