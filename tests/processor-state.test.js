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

    test("refuses to continue when pending event collections are not recoverable", () => {
        const state = makeState();
        state.activeEvents["event-9"].channels = null;
        expect(() => loadProcessorWithState(JSON.stringify(state))).toThrow(
            /invalid pending event collections/
        );
    });
});
