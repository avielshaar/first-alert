function safelyExtract(extractor, ...args) {
    try {
        return typeof extractor === "function" ? (extractor(...args) || "") : "";
    } catch (_) {
        return "";
    }
}

function hydrateMessageEvidence(message, extractors = {}) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return message;
    const text = typeof message.text === "string" ? message.text : "";
    const referenceTime = message.time || Date.now();
    return {
        ...message,
        reportedSource: typeof message.reportedSource === "string"
            ? message.reportedSource
            : safelyExtract(extractors.extractSource, text),
        reportedTarget: typeof message.reportedTarget === "string"
            ? message.reportedTarget
            : safelyExtract(extractors.extractTargets, text),
        reportedEstimatedTime: typeof message.reportedEstimatedTime === "string"
            ? message.reportedEstimatedTime
            : safelyExtract(extractors.extractTime, text, referenceTime),
    };
}
module.exports = { safelyExtract, hydrateMessageEvidence };
