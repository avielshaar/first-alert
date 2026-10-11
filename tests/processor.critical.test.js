const path = require("path");
const os = require("os");
process.env.FIRST_ALERT_STATE_FILE = path.join(os.tmpdir(), `first-alert-${process.pid}-${Date.now()}.json`);

jest.mock("../src/messaging/classifier", () => ({
    classifyMessage: jest.fn(),
    checkForNewInfo: jest.fn(),
}));
const { classifyMessage, checkForNewInfo } = require("../src/messaging/classifier");
const {
    processMessage,
    setLastPublished,
    getLastPublished,
    getActiveEvents,
} = require("../src/messaging/processor");

const callbacks = {
    alert: jest.fn(),
    update: jest.fn(),
};

const launch = {
    category: "LAUNCH_REPORT",
    reasoning: "test report",
    source: "איראן",
    target: "מרכז",
    estimated_time: "10:30",
    event_key: "איראן->מרכז",
};

function clearEvents() {
    for (const key of Object.keys(getActiveEvents())) delete getActiveEvents()[key];
}

describe("critical processor regressions", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clearEvents();
        setLastPublished(null, null, null);
        callbacks.alert.mockResolvedValue(true);
        callbacks.update.mockResolvedValue(true);
        checkForNewInfo.mockResolvedValue({ has_new_info: false, reasoning: "duplicate" });
        classifyMessage.mockResolvedValue({ ...launch });
    });

    test("one incident is stored under one canonical event, not three partial keys", async () => {
        await processMessage("channel-1", "report-1", callbacks, 101, 1767254400);
        expect(Object.keys(getActiveEvents())).toHaveLength(1);
    });

    test("a failed delivery keeps the event and asks Telegram to retry", async () => {
        callbacks.alert.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await processMessage("channel-1", "report-1", callbacks, 101, 1767254400);
        const firstAttempt = await processMessage("channel-2", "report-2", callbacks, 202, 1767254400);
        expect(firstAttempt).toBe(false);
        expect(Object.keys(getActiveEvents())).toHaveLength(1);

        const retry = await processMessage("channel-2", "report-2", callbacks, 202, 1767254400);
        expect(retry).toBe(true);
        expect(callbacks.alert).toHaveBeenCalledTimes(2);
        expect(Object.keys(getActiveEvents())).toHaveLength(0);
    });

    test("a processing error is not acknowledged as an irrelevant message", async () => {
        classifyMessage.mockResolvedValue({ category: "PROCESSING_ERROR", retryable: true, reasoning: "API unavailable" });
        const result = await processMessage("channel-1", "report", callbacks, 101, 1767254400);
        expect(result).toBe(false);
        expect(callbacks.alert).not.toHaveBeenCalled();
        expect(callbacks.update).not.toHaveBeenCalled();
    });

    test("updates require corroboration from two channels", async () => {
        setLastPublished("איראן", "מרכז", "10:00");
        classifyMessage.mockResolvedValue({
            category: "UPDATE_TO_LAST",
            reasoning: "new target",
            source: "איראן",
            target: "מרכז, צפון",
            estimated_time: "10:15",
            event_key: "איראן->מרכז, צפון",
        });

        await processMessage("channel-1", "update-1", callbacks, 111, 1767254400);
        expect(callbacks.update).not.toHaveBeenCalled();
        await processMessage("channel-2", "update-2", callbacks, 222, 1767254400);
        expect(callbacks.update).toHaveBeenCalledTimes(1);
    });
});
