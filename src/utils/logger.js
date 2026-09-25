/**
 * Centralized logging utility with timestamps
 * 
 * All console output goes through this module to ensure consistent
 * timestamp formatting (HH:MM:SS) across the entire application.
 * This makes debugging and monitoring easier.
 */

/**
 * Log a message with timestamp prefix
 * @param {string} msg - The message to log
 */
const log = (msg) => {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    console.log(`[${h}:${m}:${s}] ${msg}`);
};

module.exports = { log };
