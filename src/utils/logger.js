/**
 * Centralized application logger.
 *
 * All application output uses a date, local Israel time, a severity, and the module tag:
 *   YYYY-MM-DD HH:mm:ss [LEVEL] [Module] message
 *
 * Existing log(message) calls remain supported.
 */

const LOG_TIME_ZONE = process.env.LOG_TIME_ZONE || "Asia/Jerusalem";

function formatTimestamp(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: LOG_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return values.year + "-" + values.month + "-" + values.day + " " +
        values.hour + ":" + values.minute + ":" + values.second;
}

function inferLevel(message) {
    const text = String(message || "");
    if (/\b(error|failed|failure|exception|aborted|refusing)\b|could not|cannot|❌/i.test(text)) {
        return "ERROR";
    }
    if (/waiting for|\bretry(ing)?\b|\bambiguous\b|\bunverified\b|not found|not advanced|not confirmed|requires independent confirmation/i.test(text)) {
        return "WARN";
    }
    return "INFO";
}

/**
 * Print a timestamped, severity-tagged log entry.
 * @param {string} message Human-readable log message.
 * @param {"INFO"|"WARN"|"ERROR"|"DEBUG"} [level] Optional explicit severity.
 */
function log(message, level) {
    const safeMessage = typeof message === "string" ? message : String(message);
    const severity = level || inferLevel(safeMessage);
    console.log("[" + formatTimestamp() + "] [" + severity + "] " + safeMessage);
}

module.exports = { log, formatTimestamp, inferLevel };
