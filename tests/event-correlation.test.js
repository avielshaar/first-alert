const {
    mergeTargets,
    targetsOverlap,
    isDifferentIncident,
    findMatchingEvent,
} = require("../src/domain/event-correlation");

describe("event correlation domain", () => {
    test("merges a parenthesized sub-region into its general region", () => {
        expect(mergeTargets("מרכז (תל אביב)", "מרכז")).toBe("מרכז");
    });

    test("matches exact and parenthesized regions without arbitrary substring matches", () => {
        expect(targetsOverlap("מרכז", "מרכז (תל אביב)")).toBe(true);
        expect(targetsOverlap("מרכז", "מרכזון")).toBe(false);
    });

    test("treats disjoint confirmed targets as a different incident", () => {
        expect(isDifferentIncident(
            { source: "Iran", target: "North" },
            { source: "Iran", target: "South" }
        )).toBe(true);
    });

    test("joins one compatible partial event but refuses ambiguous candidates", () => {
        const event = { id: "event-1", kind: "LAUNCH_REPORT", source: "Iran", target: "", estimated_time: "" };
        expect(findMatchingEvent({ source: "Iran", target: "", estimated_time: "" }, "LAUNCH_REPORT", {
            "event-1": event,
        })).toBe(event);
        expect(findMatchingEvent({ source: "Iran", target: "", estimated_time: "" }, "LAUNCH_REPORT", {
            "event-1": event,
            "event-2": { ...event, id: "event-2" },
        })).toBeNull();
    });
});
