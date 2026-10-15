const fs = require("node:fs");
const path = require("node:path");

/**
 * Read the persisted per-channel cursors without silently treating corrupt state as a first run.
 * If a configured channel has an invalid cursor, or the file cannot be parsed, callers must fail
 * closed instead of baselining at the latest message and potentially skipping unprocessed alerts.
 */
function readCursorState(filePath, configuredChannelIds = [], fsImpl = fs) {
    const cursors = {};
    const initializedChannels = new Set();
    if (!fsImpl.existsSync(filePath)) {
        return { cursors, initializedChannels, error: null };
    }

    const configuredIds = new Set(configuredChannelIds.map(String));
    try {
        const parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("cursor file must contain a JSON object");
        }

        for (const [channelId, rawId] of Object.entries(parsed)) {
            // Only JSON numbers or digit-only legacy strings represent persisted message IDs.
            // Number(null), Number(false), and Number("") all become zero and must not
            // make a corrupted cursor look like a valid first-run baseline.
            const hasValidType = typeof rawId === "number" ||
                (typeof rawId === "string" && /^\\d+$/.test(rawId));
            const id = hasValidType ? Number(rawId) : NaN;
            if (!Number.isSafeInteger(id) || id < 0) {
                if (configuredIds.has(String(channelId))) {
                    throw new Error("invalid cursor for configured channel " + channelId);
                }
                continue;
            }
            cursors[channelId] = id;
            initializedChannels.add(String(channelId));
        }

        return { cursors, initializedChannels, error: null };
    } catch (error) {
        return {
            cursors: {},
            initializedChannels: new Set(),
            error: error && error.message ? error.message : String(error),
        };
    }
}

/**
 * Atomically persist one cursor. Memory is updated by the caller only after this succeeds.
 */
function writeCursorState(filePath, currentCursors, channelId, messageId, fsImpl = fs) {
    const numericId = Number(messageId);
    if (!Number.isSafeInteger(numericId) || numericId < 0) {
        throw new Error("Invalid Telegram message cursor for " + channelId);
    }

    const next = { ...currentCursors, [String(channelId)]: numericId };
    const tempFile = filePath + ".tmp";
    try {
        fsImpl.mkdirSync(path.dirname(tempFile), { recursive: true });
        fsImpl.writeFileSync(tempFile, JSON.stringify(next, null, 2), { mode: 0o600 });
        try {
            fsImpl.chmodSync(tempFile, 0o600);
        } catch (_) {
            // Permissions may not be supported on some platforms.
        }
        fsImpl.renameSync(tempFile, filePath);
        return next;
    } catch (error) {
        try {
            fsImpl.unlinkSync(tempFile);
        } catch (_) {
            // Ignore best-effort temporary-file cleanup failures.
        }
        throw error;
    }
}

module.exports = { readCursorState, writeCursorState };
