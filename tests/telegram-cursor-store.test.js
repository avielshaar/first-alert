const fs = require("fs");
const os = require("os");
const path = require("path");
const { readCursorState, writeCursorState } = require("../src/clients/telegram-cursor-store");

const temporaryDirectories = [];

function temporaryFile() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "first-alert-cursors-"));
    temporaryDirectories.push(directory);
    return {
        directory,
        file: path.join(directory, "cursors.json"),
    };
}

afterEach(() => {
    while (temporaryDirectories.length) {
        fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
    }
});

describe("Telegram cursor persistence", () => {
    test("a missing file is a clean first-run state", () => {
        const { file } = temporaryFile();
        const result = readCursorState(file, ["-1001"]);
        expect(result.error).toBeNull();
        expect(result.cursors).toEqual({});
        expect(result.initializedChannels.size).toBe(0);
    });

    test("restores valid per-channel cursors", () => {
        const { file } = temporaryFile();
        fs.writeFileSync(file, JSON.stringify({ "-1001": 123, "-1002": "456" }));

        const result = readCursorState(file, ["-1001", "-1002"]);

        expect(result.error).toBeNull();
        expect(result.cursors).toEqual({ "-1001": 123, "-1002": 456 });
        expect([...result.initializedChannels]).toEqual(["-1001", "-1002"]);
    });

    test("malformed JSON is reported instead of being mistaken for a first run", () => {
        const { file } = temporaryFile();
        fs.writeFileSync(file, '{"-1001":');

        const result = readCursorState(file, ["-1001"]);

        expect(result.error).toBeTruthy();
        expect(result.cursors).toEqual({});
        expect(result.initializedChannels.size).toBe(0);
    });

    test("an invalid cursor for a configured channel fails closed", () => {
        const { file } = temporaryFile();
        fs.writeFileSync(file, JSON.stringify({ "-1001": -2, "-1002": 456 }));

        const result = readCursorState(file, ["-1001", "-1002"]);

        expect(result.error).toContain("invalid cursor for configured channel -1001");
        expect(result.cursors).toEqual({});
        expect(result.initializedChannels.size).toBe(0);
    });

    test("ignores invalid stale entries for channels no longer configured", () => {
        const { file } = temporaryFile();
        fs.writeFileSync(file, JSON.stringify({ "-1001": 123, "-1999": "invalid" }));

        const result = readCursorState(file, ["-1001"]);

        expect(result.error).toBeNull();
        expect(result.cursors).toEqual({ "-1001": 123 });
    });

    test("writes updated cursor state atomically and retains other channels", () => {
        const { file } = temporaryFile();
        const existing = { "-1001": 123 };
        const next = writeCursorState(file, existing, "-1002", 456);

        expect(next).toEqual({ "-1001": 123, "-1002": 456 });
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(next);
        expect(fs.existsSync(file + ".tmp")).toBe(false);
    });

    test("rejects invalid cursor values without modifying persisted state", () => {
        const { file } = temporaryFile();
        fs.writeFileSync(file, JSON.stringify({ "-1001": 123 }));

        expect(() => writeCursorState(file, { "-1001": 123 }, "-1001", NaN))
            .toThrow("Invalid Telegram message cursor for -1001");
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ "-1001": 123 });
    });
});
