function splitTargets(value) {
    return (value || "").split(",").map(s => s.trim()).filter(Boolean);
}

function mergeTargets(existing, incoming) {
    const all = [...new Set([...splitTargets(existing), ...splitTargets(incoming)])];
    // Only collapse a general region and its parenthesized sub-region; avoid arbitrary substring matches.
    const merged = all.filter(item => !all.some(other =>
        other !== item && item.startsWith(`${other} (`) && item.endsWith(")")
    ));
    return merged.sort().join(", ");
}

function targetsOverlap(left, right) {
    const a = splitTargets(left);
    const b = splitTargets(right);
    if (!a.length || !b.length) return false;
    return a.some(x => b.some(y =>
        x === y || x.startsWith(`${y} (`) || y.startsWith(`${x} (`)
    ));
}

function isDifferentIncident(event, published) {
    if (!published) return true;
    if (event.source && published.source && event.source !== published.source) return true;
    // Two corroborated reports to disjoint targets should not be blindly merged as an update.
    if (event.target && published.target && !targetsOverlap(event.target, published.target)) return true;
    return false;
}

function findMatchingEvent(classification, kind, activeEvents) {
    const source = classification.source || "";
    const target = classification.target || "";
    const estimatedTime = classification.estimated_time || "";

    const candidates = Object.values(activeEvents).filter(event => {
        // Keep gathering evidence for a recently published event that still has unverified fields,
        // even if the classifier labels the next message with the other valid event category.
        if (event.kind !== kind && !event.corroborationPending) return false;
        if (source && event.source && source !== event.source) return false;

        const targetMatch = target && event.target && targetsOverlap(target, event.target);
        if (kind === "UPDATE_TO_LAST") {
            // An update is tied to the currently published event. Its target includes prior known areas,
            // so a target match is the strongest available correlation signal.
            if (targetMatch) return true;
            if (!target || !event.target) return !estimatedTime || !event.estimated_time || estimatedTime === event.estimated_time;
            return false;
        }

        if (targetMatch) return true;
        // A different known target is a contradiction, even when the incoming report omits its source.
        if (target && event.target) return false;
        // Partial reports may be joined only if there is no contradiction. The caller merges only
        // a unique compatible candidate; ambiguous source-only/target-only reports stay separate.
        const hasPartialFields = !source || !event.source || !target || !event.target;
        return hasPartialFields && Boolean(source || event.source || target || event.target);
    });

    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
        // Prefer a uniquely exact source/target match; otherwise leave the reports separate.
        const exact = candidates.filter(event =>
            (!source || event.source === source) && (!target || event.target === target)
        );
        if (exact.length === 1) return exact[0];
    }
    return null;
}

module.exports = {
    splitTargets,
    mergeTargets,
    targetsOverlap,
    isDifferentIncident,
    findMatchingEvent,
};
