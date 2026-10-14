const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    readJsonStateFile,
    writeJsonStateFile,
} = require("../src/infrastructure/processor-state-file");

describe("processor state file infrastructure", () => {
    let directory;
    let filePath;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), "first-alert-state-"));
        filePath = path.join(directory, "state.json");
    });

    afterEach(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test("distinguishes a missing state file from a stored JSON value", () => {
        expect(readJsonStateFile(filePath)).toEqual({ exists: false, value: undefined });
        writeJsonStateFile(filePath, { version: 1, events: [] });
        expect(readJsonStateFile(filePath)).toEqual({
            exists: true,
            value: { version: 1, events: [] },
        });
    });

    test("surfaces malformed JSON for the caller to handle", () => {
        fs.writeFileSync(filePath, "{not json", "utf8");
        expect(() => readJsonStateFile(filePath)).toThrow();
    });
});
