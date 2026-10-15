const { splitTargets, mergeTargets, targetsOverlap } = require("./event-correlation");

function getEvidenceMessages(event) {
    return (Array.isArray(event.messages) ? event.messages : [])
        .filter(message => message && typeof message === "object" && !Array.isArray(message));
}

function getSourceVoteMap(messages) {
    const votes = new Map();
    for (const message of messages) {
        const source = String(message.reportedSource || "").trim();
        const channel = String(message.channel || "");
        if (!source || !channel) continue;
        if (!votes.has(source)) votes.set(source, new Set());
        votes.get(source).add(channel);
    }
    return votes;
}

function getTargetVoteMap(messages) {
    const candidates = new Set();
    for (const message of messages) {
        for (const target of splitTargets(message.reportedTarget)) candidates.add(target);
    }
    const votes = new Map();
    for (const candidate of candidates) {
        const channels = new Set();
        for (const message of messages) {
            const channel = String(message.channel || "");
            if (!channel) continue;
            if (splitTargets(message.reportedTarget).some(target => targetsOverlap(candidate, target))) {
                channels.add(channel);
            }
        }
        votes.set(candidate, channels);
    }
    return votes;
}

function parseClockMinutes(value) {
    const match = /^(?:([01]?\d|2[0-3])):([0-5]\d)$/.exec(String(value || "").trim());
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function formatClockMinutes(value) {
    const minute = ((Math.round(value) % 1440) + 1440) % 1440;
    return String(Math.floor(minute / 60)).padStart(2, "0") + ":" +
        String(minute % 60).padStart(2, "0");
}

function getTimeEstimates(event) {
    // Count one observation per channel; repeated posts are not independent votes.
    const latestByChannel = new Map();
    for (const message of getEvidenceMessages(event)) {
        const value = String(message.reportedEstimatedTime || "").trim();
        if (parseClockMinutes(value) === null) continue;
        const channel = String(message.channel || "");
        if (!channel) continue;
        const timestamp = Number(message.time) || 0;
        const current = latestByChannel.get(channel);
        if (!current || timestamp >= current.timestamp) {
            latestByChannel.set(channel, { channel, value, timestamp });
        }
    }
    return [...latestByChannel.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function getCorroboratedTime(event) {
    const estimates = getTimeEstimates(event);
    if (estimates.length < 2) return "";

    const anchor = parseClockMinutes(estimates[0].value);
    // Unwrap values around midnight so 23:59 and 00:02 are treated as 3 minutes apart.
    const minutes = estimates.map(estimate => {
        let value = parseClockMinutes(estimate.value);
        while (value - anchor > 720) value -= 1440;
        while (value - anchor < -720) value += 1440;
        return value;
    }).sort((a, b) => a - b);

    const spread = minutes[minutes.length - 1] - minutes[0];
    const middle = Math.floor(minutes.length / 2);
    const median = minutes.length % 2
        ? minutes[middle]
        : (minutes[middle - 1] + minutes[middle]) / 2;

    if (spread <= 3) {
        const estimate = minutes.length === 2
            ? (minutes[0] + minutes[1]) / 2
            : median;
        return formatClockMinutes(estimate);
    }

    const range = formatClockMinutes(minutes[0]) + "–" +
        formatClockMinutes(minutes[minutes.length - 1]);
    return estimates.length >= 3
        ? range + " (חציון " + formatClockMinutes(median) + ")"
        : range;
}

function getCorroboratedFields(event) {
    const messages = getEvidenceMessages(event);
    const sourceVotes = getSourceVoteMap(messages);
    const verifiedSources = [...sourceVotes.entries()].filter(([, channels]) => channels.size >= 2);
    const source = verifiedSources.length === 1 ? verifiedSources[0][0] : "";

    const targetVotes = getTargetVoteMap(messages);
    const verifiedTargets = [...targetVotes.entries()]
        .filter(([, channels]) => channels.size >= 2)
        .map(([target]) => target);
    const target = mergeTargets("", verifiedTargets.join(", "));

    return { source, target, estimated_time: getCorroboratedTime(event) };
}

function getPendingUncorroboratedFields(event, published) {
    const messages = getEvidenceMessages(event);
    const pending = new Set();

    const sourceVotes = getSourceVoteMap(messages);
    const confirmedSourceCandidates = [...sourceVotes.values()].filter(channels => channels.size >= 2);
    if (sourceVotes.size > 1 && confirmedSourceCandidates.length !== 1) {
        pending.add("source");
    }
    for (const [source, channels] of sourceVotes) {
        if (channels.size === 1 && source !== String(published && published.source || "")) {
            pending.add("source");
        }
    }

    const publishedTargets = splitTargets(published && published.target);
    for (const [target, channels] of getTargetVoteMap(messages)) {
        const alreadyPublished = publishedTargets.some(existing => targetsOverlap(existing, target));
        if (channels.size === 1 && !alreadyPublished) pending.add("target");
    }

    const estimates = getTimeEstimates(event);
    if (estimates.length === 1 &&
        estimates[0].value !== String(published && published.estimated_time || "")) {
        pending.add("time");
    }
    return [...pending];
}
module.exports = {
    getEvidenceMessages,
    getSourceVoteMap,
    getTargetVoteMap,
    parseClockMinutes,
    formatClockMinutes,
    getTimeEstimates,
    getCorroboratedTime,
    getCorroboratedFields,
    getPendingUncorroboratedFields,
};
