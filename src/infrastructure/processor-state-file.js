const fs = require("node:fs");
const path = require("node:path");

/**
 * Read JSON state from disk.
 * A missing file is a first-run condition; I/O and JSON errors are returned to the caller.
 */
function readJsonStateFile(filePath, fsImpl = fs) {
    if (!fsImpl.existsSync(filePath)) return { exists: false, value: undefined };
    return {
        exists: true,
        value: JSON.parse(fsImpl.readFileSync(filePath, "utf8")),
    };
}

/**
 * Persist JSON state using a same-directory temporary file and atomic rename.
 * The caller owns retry policy and error logging.
 */
function writeJsonStateFile(filePath, payload, fsImpl = fs) {
    const tempFile = `${filePath}.tmp`;
    try {
        fsImpl.mkdirSync(path.dirname(tempFile), { recursive: true });
        fsImpl.writeFileSync(tempFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
        try {
            fsImpl.chmodSync(tempFile, 0o600);
        } catch (_) {
            // Permissions may not be supported on some platforms.
        }
        fsImpl.renameSync(tempFile, filePath);
    } catch (error) {
        try {
            fsImpl.unlinkSync(tempFile);
        } catch (_) {
            // Best-effort cleanup after a failed write.
        }
        throw error;
    }
}

module.exports = { readJsonStateFile, writeJsonStateFile };
