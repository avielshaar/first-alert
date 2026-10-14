/**
 * Centralized application logger.
 *
 * Keeps a single, grep-friendly log format across local runs and Docker:
 *   YYYY-MM-DD HH:mm:ss [LEVEL] [Module] message
 *
 * Existing log(message) calls remain supported. Severity is inferred conservatively
 * from the message, and callers can pass an explicit level when needed.
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
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function inferLevel(message) {
    const text = String(message || "");
    if (/\b(error|failed|failure|exception|aborted|invalid|refusing)\b|could not|cannot|❌/i.test(text)) {
        return "ERROR";
    if (/waiting for|\bretry(ing)?\b|\bambiguous\b|\bunverified\b|not found|not advanced|not confirmed|requires independent confirmation/i.test(text)) {
    if (/\b(waiting|pending|retry|retrying|ambiguous|unverified|expired|warning)\b|not found|not advanced|not confirmed/i.test(text)) {
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
    console.log(`[${formatTimestamp()}] [${severity}] ${safeMessage}`);
}

module.exports = { log, formatTimestamp, inferLevel };
