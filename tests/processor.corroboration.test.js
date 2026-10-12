const path = require("node:path");
const os = require("node:os");

process.env.FIRST_ALERT_STATE_FILE = path.join(
    os.tmpdir(),
    `first-alert-corroboration-${process.pid}-${Date.now()}.json`
);

jest.mock("../src/messaging/classifier", () => ({
    classifyMessage: jest.fn(),
    extractSource: jest.fn(() => ""),
    extractTargets: jest.fn(() => ""),
    extractTime: jest.fn(() => ""),
}));

const { classifyMessage } = require("../src/messaging/classifier");
const {
    processMessage,
    setLastPublished,
    getActiveEvents,
} = require("../src/messaging/processor");

const callbacks = {
    alert: jest.fn(),
    update: jest.fn(),
};

function classification({
    category = "LAUNCH_REPORT",
    source = "",
    target = "",
    time = "",
    reportedSource = source,
    reportedTarget = target,
    reportedTime = time,
} = {}) {
    return {
        category,
        reasoning: "test report",
        source,
        target,
        estimated_time: time,
        reportedSource,
        reportedTarget,
        reportedEstimatedTime: reportedTime,
    };
}

function clearEvents() {
    for (const key of Object.keys(getActiveEvents())) delete getActiveEvents()[key];
}

describe("field-level cross-channel corroboration", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clearEvents();
        setLastPublished(null, null, null);
        callbacks.alert.mockResolvedValue(true);
        callbacks.update.mockResolvedValue(true);
    });

    test("does not publish a source country supported by only one channel", async () => {
        classifyMessage
            .mockResolvedValueOnce(classification({ source: "איראן", target: "דרום" }))
            .mockResolvedValueOnce(classification({ source: "", target: "דרום" }));

        await processMessage("channel-1", "report-1", callbacks, 101, 1767254400);
        await processMessage("channel-2", "report-2", callbacks, 201, 1767254401);

        expect(callbacks.alert).toHaveBeenCalledTimes(1);
        expect(callbacks.alert).toHaveBeenCalledWith("", "דרום", "");
    });

    test("waits for two channels to confirm the target before publishing", async () => {
        classifyMessage
            .mockResolvedValueOnce(classification({ target: "דרום" }))
            .mockResolvedValueOnce(classification({ target: "" }))
            .mockResolvedValueOnce(classification({ target: "דרום" }));

        await processMessage("channel-1", "south report", callbacks, 101, 1767254400);
        await processMessage("channel-2", "generic launch report", callbacks, 201, 1767254401);

        expect(callbacks.alert).not.toHaveBeenCalled();
        expect(Object.keys(getActiveEvents())).toHaveLength(1);

        await processMessage("channel-3", "south corroboration", callbacks, 301, 1767254402);

        expect(callbacks.alert).toHaveBeenCalledTimes(1);
        expect(callbacks.alert).toHaveBeenCalledWith("", "דרום", "");
    });

    test("averages two corroborated estimates when their spread is at most three minutes", async () => {
        setLastPublished("איראן", "דרום", "10:00");
        classifyMessage
            .mockResolvedValueOnce(classification({
                category: "UPDATE_TO_LAST", source: "איראן", target: "דרום", time: "10:05",
            }))
            .mockResolvedValueOnce(classification({
                category: "UPDATE_TO_LAST", source: "איראן", target: "דרום", time: "10:07",
            }));

        await processMessage("channel-1", "ETA 10:05", callbacks, 111, 1767254400);
        await processMessage("channel-2", "ETA 10:07", callbacks, 222, 1767254401);

        expect(callbacks.update).toHaveBeenCalledTimes(1);
        expect(callbacks.update.mock.calls[0][0]).toEqual({
            source: "איראן",
            target: "דרום",
            estimated_time: "10:06",
        });
        expect(callbacks.update.mock.calls[0][2]).toBe("time");
    });

    test("shows a range when two corroborated estimates differ by more than three minutes", async () => {
        setLastPublished("איראן", "דרום", "10:00");
        classifyMessage
            .mockResolvedValueOnce(classification({
                category: "UPDATE_TO_LAST", source: "איראן", target: "דרום", time: "10:05",
            }))
            .mockResolvedValueOnce(classification({
                category: "UPDATE_TO_LAST", source: "איראן", target: "דרום", time: "10:10",
            }));

        await processMessage("channel-1", "ETA 10:05", callbacks, 111, 1767254400);
        await processMessage("channel-2", "ETA 10:10", callbacks, 222, 1767254401);

        expect(callbacks.update).toHaveBeenCalledTimes(1);
        expect(callbacks.update.mock.calls[0][0].estimated_time).toBe("10:05–10:10");
    });

    test("does not add a new target area until two channels support that area", async () => {
        setLastPublished("איראן", "דרום", "10:00");
        classifyMessage
            .mockResolvedValueOnce(classification({
                category: "UPDATE_TO_LAST",
                source: "איראן",
                target: "דרום, מרכז",
                reportedSource: "איראן",
                reportedTarget: "מרכז",
                reportedTime: "",
            }))
            .mockResolvedValueOnce(classification({
                category: "UPDATE_TO_LAST",
                source: "איראן",
                target: "דרום",
                reportedSource: "",
                reportedTarget: "",
                reportedTime: "",
            }));

        await processMessage("channel-1", "new target", callbacks, 111, 1767254400);
        await processMessage("channel-2", "generic update", callbacks, 222, 1767254401);

        expect(callbacks.update).not.toHaveBeenCalled();
        expect(Object.keys(getActiveEvents())).toHaveLength(1);
    });
});
