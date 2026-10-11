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

require("dotenv").config();

// Telegram credentials for user account client authentication
const TELEGRAM_API_ID       = parseInt(process.env.TELEGRAM_API_ID);
const TELEGRAM_API_HASH     = process.env.TELEGRAM_API_HASH;

// Array of Telegram channel IDs to monitor for launch alerts
const ALERT_CHANNELS        = process.env.ALERT_CHANNELS 
    ? process.env.ALERT_CHANNELS.split(',').map(id => id.trim()) 
    : [];

// Target WhatsApp group name where verified alerts will be sent
const TARGET_WHATSAPP_GROUP = process.env.WHATSAPP_GROUPS;

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
    Number.isFinite(parsedDedupMinutes) && parsedDedupMinutes >= 0
        ? parsedDedupMinutes
        : 15;
const LAST_PUBLISHED_DEDUP_WINDOW_MS = LAST_PUBLISHED_DEDUP_WINDOW_MINUTES * 60 * 1000;

// Minimum number of channels required to confirm and publish an alert
// To prevent false alerts, we require corroboration from at least 2 channels
const MIN_CHANNELS_TO_ACT = 2;

module.exports = {
    TELEGRAM_API_ID,
    TELEGRAM_API_HASH,
    ALERT_CHANNELS,
    TARGET_WHATSAPP_GROUP,
    CONTEXT_WINDOW_MS,
    LAST_PUBLISHED_DEDUP_WINDOW_MINUTES,
    LAST_PUBLISHED_DEDUP_WINDOW_MS,
    MIN_CHANNELS_TO_ACT,
};
