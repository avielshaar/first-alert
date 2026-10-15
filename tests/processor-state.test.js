const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

jest.mock("../src/messaging/classifier", () => ({
    classifyMessage: jest.fn(),
    checkForNewInfo: jest.fn(),
}));

const originalStateFile = process.env.FIRST_ALERT_STATE_FILE;
let tempDir;

function makeState(overrides = {}) {
    return {
        version: 1,
        nextEventId: 10,
        lastPublished: null,
        activeEvents: {
            "event-9": {
                id: "event-9",
                kind: "LAUNCH_REPORT",
                channels: ["-1001"],
                messages: [{ channel: "-1001", messageId: 123, text: "test", time: 1767254400000 }],
                messageKeys: ["-1001:123"],
                source: "איראן",
                target: "מרכז",
                estimated_time: "10:00",
                firstSeen: 1767254400000,
                lastSeen: 1767254400000,
            },
        },
        ...overrides,
    };
}

function loadProcessorWithState(contents) {
    const file = path.join(tempDir, "processor-state.json");
    fs.writeFileSync(file, contents);
    process.env.FIRST_ALERT_STATE_FILE = file;
    jest.resetModules();
    return require("../src/messaging/processor");
}

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "first-alert-processor-state-"));
});

afterEach(() => {
    process.env.FIRST_ALERT_STATE_FILE = originalStateFile;
    jest.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("processor state recovery safety", () => {
    test("restores a well-formed event and a non-colliding next ID", () => {
        const processor = loadProcessorWithState(JSON.stringify(makeState()));

        expect(Object.keys(processor.getActiveEvents())).toEqual(["event-9"]);
        expect([...processor.getActiveEvents()["event-9"].channels]).toEqual(["-1001"]);
    });

    test.each([
        ["לבנון", "צפון", "different source and target"],
        ["איראן", "צפון", "same source but conflicting target"],
        ["לבנון", "מרכז", "same target but conflicting source"],
    ])("does not duplicate a legacy published Iran incident when global baseline is %s -> %s (%s)", async (globalSource, globalTarget) => {
        const now = Date.now();
        const state = makeState({
            lastPublished: {
                source: globalSource,
                target: globalTarget,
                estimated_time: "09:00",
                verificationVersion: 1,
                publishedAt: now,
            },
            activeEvents: {
                "event-9": {
                    id: "event-9",
                    kind: "UPDATE_TO_LAST",
                    channels: ["channel-A", "channel-B"],
                    messages: [
                        {
                            channel: "channel-A",
                            messageId: 101,
                            text: "Iran report",
                            reportedSource: "איראן",
                            reportedTarget: "מרכז",
                            reportedEstimatedTime: "10:30",
                            time: now,
                        },
                        {
                            channel: "channel-B",
                            messageId: 201,
                            text: "Iran corroboration",
                            reportedSource: "איראן",
                            reportedTarget: "מרכז",
                            reportedEstimatedTime: "10:30",
                            time: now + 1,
                        },
                    ],
                    messageKeys: ["channel-A:101", "channel-B:201"],
                    source: "איראן",
                    target: "מרכז",
                    estimated_time: "10:30",
                    firstSeen: now - 1000,
                    lastSeen: now,
                    corroborationPending: true,
                },
            },
        });
        const processor = loadProcessorWithState(JSON.stringify(state));
        const classifier = require("../src/messaging/classifier");
        classifier.classifyMessage.mockResolvedValue({
            category: "LAUNCH_REPORT",
            reasoning: "repeat from a legacy published incident",
            source: "איראן",
            target: "מרכז",
            estimated_time: "10:30",
            reportedSource: "איראן",
            reportedTarget: "מרכז",
            reportedEstimatedTime: "10:30",
        });
        const callbacks = {
            alert: jest.fn().mockResolvedValue(true),
            update: jest.fn().mockResolvedValue(true),
        };

        const result = await processor.processMessage(
            "channel-A", "repeat Iran report", callbacks, 301, Math.floor(now / 1000)
        );

        expect(result).toBe(true);
        expect(callbacks.alert).not.toHaveBeenCalled();
        expect(callbacks.update).not.toHaveBeenCalled();
    });

    test("restores an incident-specific publication baseline across restart", () => {
        const baseline = {
            source: "איראן",
            target: "מרכז",
            estimated_time: "10:30",
            verificationVersion: 1,
            publishedAt: Date.now(),
        };
        const state = makeState({
            activeEvents: {
                "event-9": {
                    id: "event-9",
                    kind: "UPDATE_TO_LAST",
                    channels: ["-1001", "-1002"],
                    messages: [],
                    messageKeys: [],
                    source: "איראן",
                    target: "מרכז",
                    estimated_time: "10:30",
                    firstSeen: 1767254400000,
                    lastSeen: 1767254400000,
                    corroborationPending: true,
                    publishedBaseline: baseline,
                },
            },
        });

        const processor = loadProcessorWithState(JSON.stringify(state));

        expect(processor.getActiveEvents()["event-9"].publishedBaseline).toEqual(baseline);
    });

    test("refuses to continue when processor state JSON is malformed", () => {
        expect(() => loadProcessorWithState('{"version":1,')).toThrow(
            /Refusing to start to avoid losing pending incident evidence/
        );
    });

    test("refuses to continue instead of silently discarding an event with an invalid kind", () => {
        const state = makeState();
        state.activeEvents["event-9"].kind = "UNKNOWN";
        expect(() => loadProcessorWithState(JSON.stringify(state))).toThrow(
            /invalid pending event kind/
        );
    });

    test("refuses to continue when a restored event would collide with nextEventId", () => {
        const state = makeState({ nextEventId: 1 });
        expect(() => loadProcessorWithState(JSON.stringify(state))).toThrow(
            /nextEventId would collide with a pending event/
        );
    });

    test.each(["source", "target", "estimated_time"])(
        "refuses to continue when restored lastPublished.%s is not a string",
        field => {
            const state = makeState({
                lastPublished: {
                    source: "איראן",
                    target: "מרכז",
                    estimated_time: "10:00",
                    verificationVersion: 1,
                    publishedAt: 1767254400000,
                },
            });
            state.lastPublished[field] = { malformed: true };

            expect(() => loadProcessorWithState(JSON.stringify(state))).toThrow(
                new RegExp("invalid lastPublished " + field)
            );
        }
    );

    test("refuses to continue when restored publication verification version is unsupported", () => {
        const state = makeState({
            lastPublished: {
                source: "איראן",
                target: "מרכז",
                estimated_time: "10:00",
                verificationVersion: 999,
                publishedAt: 1767254400000,
            },
        });

        expect(() => loadProcessorWithState(JSON.stringify(state))).toThrow(
            /unsupported lastPublished verificationVersion/
        );
    });

    test("refuses to continue when pending event collections are not recoverable", () => {
        const state = makeState();
        state.activeEvents["event-9"].channels = null;
        expect(() => loadProcessorWithState(JSON.stringify(state))).toThrow(
            /invalid pending event collections/
        );
    });
});
