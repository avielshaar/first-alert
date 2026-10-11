const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    resolveWhatsAppAuthPath,
    prepareWhatsAppAuthPath,
    findUniqueTargetGroup,
} = require("../src/clients/whatsapp-helpers");

const temporaryDirectories = [];

function makeTemporaryDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "first-alert-whatsapp-"));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    while (temporaryDirectories.length) {
        fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
    }
});

describe("WhatsApp helper functions", () => {
    test("uses the persistent data directory by default", () => {
        const cwd = makeTemporaryDirectory();
        expect(resolveWhatsAppAuthPath({}, cwd)).toBe(path.join(cwd, "data", "wwebjs_auth"));
    });

    test("honors an explicit WhatsApp auth path", () => {
        const cwd = makeTemporaryDirectory();
        expect(resolveWhatsAppAuthPath({
            APP_DATA_DIR: "./other-data",
            WHATSAPP_AUTH_PATH: "./secure/whatsapp-session",
        }, cwd)).toBe(path.join(cwd, "secure", "whatsapp-session"));
    });

    test("migrates an existing legacy session to the persistent path", () => {
        const cwd = makeTemporaryDirectory();
        const legacySession = path.join(cwd, ".wwebjs_auth", "session", "session.json");
        fs.mkdirSync(path.dirname(legacySession), { recursive: true });
        fs.writeFileSync(legacySession, '{"authenticated":true}');

        const result = prepareWhatsAppAuthPath({ env: {}, cwd });

        expect(result.path).toBe(path.join(cwd, "data", "wwebjs_auth"));
        expect(result.migrated).toBe(true);
        expect(fs.readFileSync(path.join(result.path, "session", "session.json"), "utf8"))
            .toBe('{"authenticated":true}');
        expect(fs.existsSync(path.join(cwd, ".wwebjs_auth"))).toBe(false);
    });

    test("does not overwrite an existing configured session or delete the legacy copy", () => {
        const cwd = makeTemporaryDirectory();
        const target = path.join(cwd, "data", "wwebjs_auth");
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, "keep.txt"), "new");
        const legacy = path.join(cwd, ".wwebjs_auth");
        fs.mkdirSync(legacy, { recursive: true });
        fs.writeFileSync(path.join(legacy, "keep.txt"), "legacy");

        const result = prepareWhatsAppAuthPath({ env: {}, cwd });

        expect(result.migrated).toBe(false);
        expect(fs.readFileSync(path.join(target, "keep.txt"), "utf8")).toBe("new");
        expect(fs.readFileSync(path.join(legacy, "keep.txt"), "utf8")).toBe("legacy");
    });

    test("selects one exact group match, never a personal chat or a guessed duplicate", () => {
        const target = { isGroup: true, name: "Alert Group", id: "target" };
        const duplicate = { isGroup: true, name: "Alert Group", id: "duplicate" };
        const personalChat = { isGroup: false, name: "Alert Group", id: "personal" };

        expect(findUniqueTargetGroup([personalChat, target], "Alert Group")).toBe(target);
        expect(findUniqueTargetGroup([target, duplicate], "Alert Group")).toBeNull();
        expect(findUniqueTargetGroup([personalChat], "Alert Group")).toBeNull();
        expect(findUniqueTargetGroup([target], "Different Name")).toBeNull();
        expect(findUniqueTargetGroup([], "Alert Group")).toBeNull();
    });
});
