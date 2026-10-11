const fs = require("node:fs");
const path = require("node:path");

/**
 * Resolve the directory used by whatsapp-web.js LocalAuth.
 * Keep it inside the persistent data directory by default, while allowing deployments
 * to override the path explicitly.
 */
function resolveWhatsAppAuthPath(env = process.env, cwd = process.cwd()) {
    const configuredPath = env.WHATSAPP_AUTH_PATH ||
        path.join(env.APP_DATA_DIR || "./data", "wwebjs_auth");
    return path.resolve(cwd, configuredPath);
}

/**
 * Move an older root-level .wwebjs_auth directory to the configured persistent path.
 * Copy first instead of rename so migration also works across mount/filesystem boundaries.
 * If migration fails, throw: silently starting an empty session could force re-authentication.
 */
function prepareWhatsAppAuthPath(options = {}) {
    const env = options.env || process.env;
    const cwd = options.cwd || process.cwd();
    const fsImpl = options.fsImpl || fs;
    const authPath = resolveWhatsAppAuthPath(env, cwd);
    const legacyPath = path.resolve(cwd, ".wwebjs_auth");

    if (
        authPath !== legacyPath &&
        !fsImpl.existsSync(authPath) &&
        fsImpl.existsSync(legacyPath)
    ) {
        fsImpl.mkdirSync(path.dirname(authPath), { recursive: true });
        fsImpl.cpSync(legacyPath, authPath, {
            recursive: true,
            errorOnExist: true,
            force: false,
        });
        fsImpl.rmSync(legacyPath, { recursive: true, force: true });
        return { path: authPath, migrated: true, legacyPath };
    }

    return { path: authPath, migrated: false, legacyPath };
}

/**
 * Return a group only when the configured exact name identifies one unambiguous group.
 * Personal chats with the same name are never eligible.
 */
function findUniqueTargetGroup(chats, targetName) {
    if (!Array.isArray(chats) || !targetName) return null;
    const matches = chats.filter(chat =>
        chat && chat.isGroup === true && chat.name === targetName
    );
    return matches.length === 1 ? matches[0] : null;
}

module.exports = {
    resolveWhatsAppAuthPath,
    prepareWhatsAppAuthPath,
    findUniqueTargetGroup,
};
