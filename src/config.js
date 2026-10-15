/**
 * Configuration Management
 * 
 * This module loads all environment variables from .env file and exports
 * constants used throughout the application. This ensures there's a single
 * source of truth for all configuration values.
 * 
 * Environment variables required:
 * - TELEGRAM_API_ID: Your Telegram user account API ID
 * - TELEGRAM_API_HASH: Your Telegram user account API hash
 * - ALERT_CHANNELS: Comma-separated list of Telegram channel IDs to monitor
 * - GEMINI_API_KEY: Google Gemini API key for AI classification
 * - WHATSAPP_GROUPS: Name of WhatsApp group to receive alerts
 */

require("dotenv").config({ quiet: true });

// Telegram credentials for user account client authentication
const TELEGRAM_API_ID       = Number.parseInt(process.env.TELEGRAM_API_ID, 10);
const TELEGRAM_API_HASH     = (process.env.TELEGRAM_API_HASH || "").trim();

// Array of Telegram channel IDs to monitor for launch alerts
function parseChannelIds(alertChannels = "", testChannels = "") {
    return [...new Set(`${alertChannels || ""},${testChannels || ""}`
        .split(",")
        .map(id => id.trim())
        .filter(Boolean))];
}

const ALERT_CHANNELS = parseChannelIds(
    process.env.ALERT_CHANNELS,
    process.env.TEST_CHANNELS
);

// Target WhatsApp group name where verified alerts will be sent
const TARGET_WHATSAPP_GROUP = (process.env.WHATSAPP_GROUPS || "").trim();
const WHATSAPP_INVITE_LINK = (process.env.WHATSAPP_INVITE_LINK || "").trim();

// Time window for grouping related messages (2 minutes).
// Messages within this window are considered part of the same event.
const CONTEXT_WINDOW_MS = 120 * 1000;

// A previously published alert is only used as the deduplication baseline for a limited time.
// This prevents an old alert (including one restored after a restart) from suppressing a new
// incident indefinitely. Set to 0 to disable cross-message deduplication against prior alerts.
const configuredDedupMinutes = process.env.LAST_PUBLISHED_DEDUP_WINDOW_MINUTES;
const parsedDedupMinutes = configuredDedupMinutes == null || configuredDedupMinutes.trim() === ""
    ? 15
    : Number(configuredDedupMinutes);
const LAST_PUBLISHED_DEDUP_WINDOW_MINUTES =
    Number.isFinite(parsedDedupMinutes) &&
    parsedDedupMinutes >= 0 &&
    Number.isFinite(parsedDedupMinutes * 60 * 1000)
        ? parsedDedupMinutes
        : 10;
const LAST_PUBLISHED_DEDUP_WINDOW_MS = LAST_PUBLISHED_DEDUP_WINDOW_MINUTES * 60 * 1000;

// Minimum number of channels required to confirm and publish an alert
// To prevent false alerts, we require corroboration from at least 2 channels
const MIN_CHANNELS_TO_ACT = 2;

/**
 * Return actionable configuration problems before any messaging clients are initialized.
 * Accept an env object so validation can be tested without mutating process.env.
 */
function validateConfig(env = process.env) {
    const errors = [];
    const rawApiId = String(env.TELEGRAM_API_ID || "").trim();
    const numericApiId = Number(rawApiId);

    if (!/^\d+$/.test(rawApiId) || !Number.isSafeInteger(numericApiId) || numericApiId <= 0) {
        errors.push("TELEGRAM_API_ID must be a positive integer.");
    }
    if (!String(env.TELEGRAM_API_HASH || "").trim()) {
        errors.push("TELEGRAM_API_HASH is required.");
    }
    if (parseChannelIds(env.ALERT_CHANNELS, env.TEST_CHANNELS).length === 0) {
        errors.push("Configure at least one channel in ALERT_CHANNELS or TEST_CHANNELS.");
    }
    if (!String(env.GEMINI_API_KEY || "").trim()) {
        errors.push("GEMINI_API_KEY is required.");
    }
    if (!String(env.WHATSAPP_GROUPS || "").trim()) {
        errors.push("WHATSAPP_GROUPS must contain the exact target WhatsApp group name.");
    }
    if (!String(env.WHATSAPP_INVITE_LINK || "").trim()) {
        errors.push("WHATSAPP_INVITE_LINK is required.");
    }

    return errors;
}

module.exports = {
    TELEGRAM_API_ID,
    TELEGRAM_API_HASH,
    ALERT_CHANNELS,
    TARGET_WHATSAPP_GROUP,
    WHATSAPP_INVITE_LINK,
    CONTEXT_WINDOW_MS,
    LAST_PUBLISHED_DEDUP_WINDOW_MINUTES,
    LAST_PUBLISHED_DEDUP_WINDOW_MS,
    MIN_CHANNELS_TO_ACT,
    parseChannelIds,
    validateConfig,
};