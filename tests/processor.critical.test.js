const path = require("path");
const os = require("os");
process.env.FIRST_ALERT_STATE_FILE = path.join(os.tmpdir(), `first-alert-${process.pid}-${Date.now()}.json`);

jest.mock("../src/messaging/classifier", () => ({
    classifyMessage: jest.fn(),
    checkForNewInfo: jest.fn(),
    extractSource: jest.fn(text => /איראן/.test(text) ? "איראן" : /לבנון/.test(text) ? "לבנון" : ""),
    extractTargets: jest.fn(text => /מרכז|גוש דן|תל אביב/.test(text) ? "מרכז" : /דרום/.test(text) ? "דרום" : /צפון/.test(text) ? "צפון" : ""),
    extractTime: jest.fn(text => (String(text).match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/) || [])[0] || ""),
    isStrictlyBlacklisted: jest.fn(text => ["נפגעים", "אין סכנה", "הוסר החשש", "שריפה", "תיעוד"].some(word => String(text).includes(word))),
    isRegionOnlyFollowUp: jest.fn(text => /^(?:(?:לעבר|לאזור|באזור|אזור|לכיוון|ולאזור|ובאזור|אל|ול|וב|ל|ב)[ -]*)?ה?(?:מרכז|דרום|צפון)(?:\s*\([^)]*\))?[\s.,!?…]*$/u.test(String(text).trim())),
}));
const { classifyMessage, checkForNewInfo } = require("../src/messaging/classifier");
const {
    processMessage,
    setLastPublished,
    getLastPublished,
    getActiveEvents,
} = require("../src/messaging/processor");

const callbacks = {
    alert: jest.fn(),
    update: jest.fn(),
};

const launch = {
    category: "LAUNCH_REPORT",
    reasoning: "test report",
    source: "איראן",
    target: "מרכז",
    estimated_time: "10:30",
    event_key: "איראן->מרכז",
};

function clearEvents() {
    for (const key of Object.keys(getActiveEvents())) delete getActiveEvents()[key];
}

describe("critical processor regressions", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        classifyMessage.mockReset();
        clearEvents();
        setLastPublished(null, null, null);
        callbacks.alert.mockResolvedValue(true);
        callbacks.update.mockResolvedValue(true);
        checkForNewInfo.mockResolvedValue({ has_new_info: false, reasoning: "duplicate" });
        classifyMessage.mockResolvedValue({ ...launch });
    });

    test.each([
        ["Iran", "Lebanon"],
        ["Lebanon", "Iran"],
    ])("a repeat for the older %s incident is not resent after %s publishes", async (firstName, secondName) => {
        const incidents = {
            Iran: {
                category: "LAUNCH_REPORT", reasoning: "Iran incident",
                source: "איראן", target: "מרכז", estimated_time: "10:30",
                reportedSource: "איראן", reportedTarget: "מרכז", reportedEstimatedTime: "10:30",
            },
            Lebanon: {
                category: "LAUNCH_REPORT", reasoning: "Lebanon incident",
                source: "לבנון", target: "צפון", estimated_time: "09:00",
                reportedSource: "לבנון", reportedTarget: "צפון", reportedEstimatedTime: "09:00",
            },
        };
        const first = incidents[firstName];
        const second = incidents[secondName];
        const repeatedFirst = {
            ...first,
            category: "UPDATE_TO_LAST",
            reasoning: "repeat of existing incident evidence",
        };

        classifyMessage
            .mockResolvedValueOnce({ ...first })
            .mockResolvedValueOnce({ ...first })
            .mockResolvedValueOnce({ ...second })
            .mockResolvedValueOnce({ ...second })
            .mockResolvedValueOnce(repeatedFirst);

        await processMessage("channel-1", firstName + " launch report 1", callbacks, 101);
        await processMessage("channel-2", firstName + " launch report 2", callbacks, 201);
        await processMessage("channel-1", secondName + " launch report 1", callbacks, 102);
        await processMessage("channel-2", secondName + " launch report 2", callbacks, 202);

        expect(callbacks.alert).toHaveBeenCalledTimes(2);
        expect(callbacks.alert).toHaveBeenNthCalledWith(
            1, first.source, first.target, first.estimated_time
        );
        expect(callbacks.alert).toHaveBeenNthCalledWith(
            2, second.source, second.target, second.estimated_time
        );

        // A repeat from the first incident must use its own baseline, regardless of
        // which of the two incidents was most recently published.
        await processMessage("channel-1", firstName + " report repeated", callbacks, 103);

        expect(callbacks.alert).toHaveBeenCalledTimes(2);
        expect(callbacks.update).not.toHaveBeenCalled();
    });

    test("one incident is stored under one canonical event, not three partial keys", async () => {
        await processMessage("channel-1", "report-1", callbacks, 101, 1767254400);
        expect(Object.keys(getActiveEvents())).toHaveLength(1);
    });

    test("saves the verified publication baseline only after a successful send", async () => {
        await processMessage("channel-1", "report-1", callbacks, 101, 1767254400);
        expect(getLastPublished()).toBeNull();

        await processMessage("channel-2", "report-2", callbacks, 202, 1767254401);

        expect(callbacks.alert).toHaveBeenCalledTimes(1);
        expect(getLastPublished()).toMatchObject({
            source: "איראן",
            target: "מרכז",
            estimated_time: "10:30",
            verificationVersion: 1,
        });
        expect(getLastPublished().publishedAt).toBeLessThanOrEqual(Date.now());
    });

    test("a thrown delivery callback is retained as pending and can be retried", async () => {
        callbacks.alert.mockRejectedValueOnce(new Error("transient send failure"));

        await processMessage("channel-1", "report-1", callbacks, 101, 1767254400);
        const firstAttempt = await processMessage("channel-2", "report-2", callbacks, 202, 1767254400);

        expect(firstAttempt).toBe(false);
        expect(getLastPublished()).toBeNull();
        expect(Object.values(getActiveEvents())[0].deliveryPending).toBe(true);

        const retry = await processMessage("channel-2", "report-2", callbacks, 202, 1767254400);

        expect(retry).toBe(true);
        expect(callbacks.alert).toHaveBeenCalledTimes(2);
        expect(getLastPublished()).toMatchObject({
            source: "איראן",
            target: "מרכז",
            verificationVersion: 1,
        });
    });

    test("a failed delivery keeps the event and asks Telegram to retry", async () => {
        callbacks.alert.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await processMessage("channel-1", "report-1", callbacks, 101, 1767254400);
        const firstAttempt = await processMessage("channel-2", "report-2", callbacks, 202, 1767254400);
        expect(firstAttempt).toBe(false);
        expect(getLastPublished()).toBeNull();
        expect(Object.keys(getActiveEvents())).toHaveLength(1);
        expect(Object.values(getActiveEvents())[0].deliveryPending).toBe(true);

        // Even an extended WhatsApp outage must not let context cleanup drop the alert.
        Object.values(getActiveEvents())[0].lastSeen = Date.now() - 10 * 60 * 1000;
        const retry = await processMessage("channel-2", "report-2", callbacks, 202, 1767254400);
        expect(retry).toBe(true);
        expect(callbacks.alert).toHaveBeenCalledTimes(2);
        const retained = Object.values(getActiveEvents());
        expect(retained).toHaveLength(1);
        expect(retained[0].corroborationPending).toBe(true);
    });

    test("messages from one channel cannot satisfy cross-channel corroboration", async () => {
        await processMessage("channel-1", "report-1", callbacks, 101, 1767254400);
        await processMessage("channel-1", "report-2", callbacks, 102, 1767254401);

        expect(callbacks.alert).not.toHaveBeenCalled();
        const events = Object.values(getActiveEvents());
        expect(events).toHaveLength(1);
        expect([...events[0].channels]).toEqual(["channel-1"]);
    });

    test("reports from different sources are kept in separate events", async () => {
        classifyMessage
            .mockResolvedValueOnce({ ...launch, source: "איראן", target: "מרכז" })
            .mockResolvedValueOnce({ ...launch, source: "לבנון", target: "מרכז" });

        await processMessage("channel-1", "report-1", callbacks, 101, 1767254400);
        await processMessage("channel-2", "report-2", callbacks, 201, 1767254401);

        expect(Object.keys(getActiveEvents())).toHaveLength(2);
        expect(callbacks.alert).not.toHaveBeenCalled();
    });

    test("a failed update delivery survives expiration of the context window", async () => {
        setLastPublished("איראן", "מרכז", "10:00");
        classifyMessage.mockResolvedValue({
            category: "UPDATE_TO_LAST",
            reasoning: "new target",
            source: "איראן",
            target: "מרכז, צפון",
            estimated_time: "10:15",
            event_key: "איראן->מרכז, צפון",
        });
        callbacks.update.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

        await processMessage("channel-1", "update-1", callbacks, 111, 1767254400);
        const firstAttempt = await processMessage("channel-2", "update-2", callbacks, 222, 1767254401);
        expect(firstAttempt).toBe(false);
        expect(Object.values(getActiveEvents())[0].deliveryPending).toBe(true);

        Object.values(getActiveEvents())[0].lastSeen = Date.now() - 10 * 60 * 1000;
        const retry = await processMessage("channel-2", "update-2", callbacks, 222, 1767254401);

        expect(retry).toBe(true);
        expect(callbacks.update).toHaveBeenCalledTimes(2);
        const retained = Object.values(getActiveEvents());
        expect(retained).toHaveLength(1);
        expect(retained[0].corroborationPending).toBe(true);
    });

    test("publishes a source-confirmed alert while a region-only follow-up remains unverified, then updates the region when corroborated", async () => {
        classifyMessage
            .mockResolvedValueOnce({
                category: "LAUNCH_REPORT",
                reasoning: "source-only launch",
                source: "איראן",
                target: "",
                estimated_time: "",
                reportedSource: "איראן",
                reportedTarget: "",
                reportedEstimatedTime: "",
            })
            .mockResolvedValueOnce({
                category: "IRRELEVANT",
                reasoning: "region-only follow-up",
                source: "",
                target: "",
                estimated_time: "",
            })
            .mockResolvedValueOnce({
                category: "LAUNCH_REPORT",
                reasoning: "independent source confirmation",
                source: "איראן",
                target: "",
                estimated_time: "",
                reportedSource: "איראן",
                reportedTarget: "",
                reportedEstimatedTime: "",
            })
            .mockResolvedValueOnce({
                category: "LAUNCH_REPORT",
                reasoning: "independent target confirmation",
                source: "איראן",
                target: "מרכז",
                estimated_time: "",
                reportedSource: "איראן",
                reportedTarget: "מרכז",
                reportedEstimatedTime: "",
            });

        await processMessage("channel-1", "שיגורים מאיראן", callbacks, 801, Date.now());
        await processMessage("channel-1", "למרכז", callbacks, 802, Date.now());
        await processMessage("channel-2", "שיגורים מאיראן", callbacks, 901, Date.now());

        // The source has two-channel support. The one-channel region must not block
        // the initial alert or be published as if it were already verified.
        expect(callbacks.alert).toHaveBeenCalledTimes(1);
        expect(callbacks.alert).toHaveBeenCalledWith("איראן", "", "");
        expect(callbacks.update).not.toHaveBeenCalled();
        expect(getLastPublished()).toMatchObject({ source: "איראן", target: "" });

        // A later independent report confirms the pending region, so send an update
        // to the already-published incident rather than another new-alert message.
        await processMessage("channel-2", "שיגורים מאיראן למרכז", callbacks, 902, Date.now());

        expect(callbacks.alert).toHaveBeenCalledTimes(1);
        expect(callbacks.update).toHaveBeenCalledTimes(1);
        expect(callbacks.update.mock.calls[0][0]).toEqual({
            source: "איראן",
            target: "מרכז",
            estimated_time: "",
        });
        expect(callbacks.update.mock.calls[0][2]).toBe("target");
        expect(getLastPublished()).toMatchObject({ source: "איראן", target: "מרכז" });
    });

    test("joins a short region-only follow-up to a unique recent source-only alert", async () => {
        classifyMessage
            .mockResolvedValueOnce({
                category: "LAUNCH_REPORT",
                reasoning: "source-only launch",
                source: "איראן",
                target: "",
                estimated_time: "",
                reportedSource: "איראן",
                reportedTarget: "",
                reportedEstimatedTime: "",
            })
            .mockResolvedValueOnce({
                category: "IRRELEVANT",
                reasoning: "region-only follow-up",
                source: "",
                target: "",
                estimated_time: "",
            })
            .mockResolvedValueOnce({
                category: "LAUNCH_REPORT",
                reasoning: "independent complete report",
                source: "איראן",
                target: "מרכז",
                estimated_time: "",
                reportedSource: "איראן",
                reportedTarget: "מרכז",
                reportedEstimatedTime: "",
            });

        await processMessage("channel-1", "שיגורים מאיראן", callbacks, 301, Date.now());
        await processMessage("channel-1", "מרכז", callbacks, 302, Date.now());

        expect(callbacks.alert).not.toHaveBeenCalled();
        const eventsAfterFollowUp = Object.values(getActiveEvents());
        expect(eventsAfterFollowUp).toHaveLength(1);
        expect(eventsAfterFollowUp[0].target).toBe("מרכז");
        expect(eventsAfterFollowUp[0].messages).toHaveLength(2);
        expect(eventsAfterFollowUp[0].messages[1].reportedTarget).toBe("מרכז");

        await processMessage("channel-2", "שיגורים מאיראן למרכז", callbacks, 401, Date.now());

        expect(callbacks.alert).toHaveBeenCalledTimes(1);
        expect(callbacks.alert).toHaveBeenCalledWith("איראן", "מרכז", "");
        expect(getLastPublished()).toMatchObject({ source: "איראן", target: "מרכז" });
    });

    test("publishes a pending region update when a second channel confirms it using a region-only message after the initial alert", async () => {
        classifyMessage
            .mockResolvedValueOnce({
                category: "LAUNCH_REPORT",
                reasoning: "source-only launch",
                source: "איראן",
                target: "",
                estimated_time: "",
                reportedSource: "איראן",
                reportedTarget: "",
                reportedEstimatedTime: "",
            })
            .mockResolvedValueOnce({
                category: "IRRELEVANT",
                reasoning: "region-only follow-up",
                source: "",
                target: "",
                estimated_time: "",
            })
            .mockResolvedValueOnce({
                category: "LAUNCH_REPORT",
                reasoning: "independent source confirmation",
                source: "איראן",
                target: "",
                estimated_time: "",
                reportedSource: "איראן",
                reportedTarget: "",
                reportedEstimatedTime: "",
            })
            .mockResolvedValueOnce({
                category: "IRRELEVANT",
                reasoning: "independent region-only confirmation",
                source: "",
                target: "",
                estimated_time: "",
            });

        await processMessage("channel-1", "שיגורים מאיראן", callbacks, 1001, Date.now());
        await processMessage("channel-1", "לדרום", callbacks, 1002, Date.now());
        await processMessage("channel-2", "שיגורים מאיראן", callbacks, 1101, Date.now());

        expect(callbacks.alert).toHaveBeenCalledTimes(1);
        expect(callbacks.alert).toHaveBeenCalledWith("איראן", "", "");
        expect(callbacks.update).not.toHaveBeenCalled();

        // A region-only message from the second channel is valid corroborating evidence.
        // It must be attached to the already-published incident and trigger an update.
        await processMessage("channel-2", "לדרום", callbacks, 1102, Date.now());

        expect(callbacks.alert).toHaveBeenCalledTimes(1);
        expect(callbacks.update).toHaveBeenCalledTimes(1);
        expect(callbacks.update.mock.calls[0][0]).toEqual({
            source: "איראן",
            target: "דרום",
            estimated_time: "",
        });
        expect(callbacks.update.mock.calls[0][2]).toBe("target");
        expect(getLastPublished()).toMatchObject({ source: "איראן", target: "דרום" });
    });

    test("explains that IRRELEVANT is message-alone classification before contextual correlation", async () => {
        classifyMessage
            .mockResolvedValueOnce({
                category: "LAUNCH_REPORT",
                reasoning: "source-only launch",
                source: "איראן",
                target: "",
                estimated_time: "",
                reportedSource: "איראן",
                reportedTarget: "",
                reportedEstimatedTime: "",
            })
            .mockResolvedValueOnce({
                category: "IRRELEVANT",
                reasoning: "Region-only follow-up has no launch verb by itself.",
                source: "",
                target: "",
                estimated_time: "",
            });

        await processMessage("channel-1", "שיגורים מאיראן", callbacks, 1201, Date.now());

        const output = jest.spyOn(console, "log").mockImplementation(() => {});
        let lines;
        try {
            await processMessage("channel-1", "למרכז", callbacks, 1202, Date.now());
            lines = output.mock.calls.map(call => String(call[0]));
        } finally {
            output.mockRestore();
        }
        expect(lines.some(line =>
            line.includes("[Classifier] channel=channel-1 message=1202 | category=IRRELEVANT | scope=message-by-itself") &&
            line.includes("next_step=check-contextual-follow-up")
        )).toBe(true);
        expect(lines.some(line =>
            line.includes("[Correlation] channel=channel-1 message=1202 | action=ATTACHED") &&
            line.includes("region=")
        )).toBe(true);
    });

    test("does not attach a region-only follow-up when multiple source-only incidents are candidates", async () => {
        classifyMessage
            .mockResolvedValueOnce({
                category: "LAUNCH_REPORT", reasoning: "Iran report",
                source: "איראן", target: "", estimated_time: "",
            })
            .mockResolvedValueOnce({
                category: "LAUNCH_REPORT", reasoning: "Lebanon report",
                source: "לבנון", target: "", estimated_time: "",
            })
            .mockResolvedValueOnce({
                category: "IRRELEVANT", reasoning: "region-only follow-up",
                source: "", target: "", estimated_time: "",
            });

        await processMessage("channel-1", "שיגורים מאיראן", callbacks, 501, Date.now());
        await processMessage("channel-2", "שיגורים מלבנון", callbacks, 601, Date.now());
        await processMessage("channel-3", "מרכז", callbacks, 701, Date.now());

        expect(Object.values(getActiveEvents())).toHaveLength(2);
        expect(Object.values(getActiveEvents()).every(event => event.target === "")).toBe(true);
        expect(callbacks.alert).not.toHaveBeenCalled();
    });

    test("does not attach a region follow-up that contains a time and may describe another incident", async () => {
        classifyMessage
            .mockResolvedValueOnce({
                category: "LAUNCH_REPORT", source: "איראן", target: "",
                estimated_time: "", reasoning: "source-only report",
            })
            .mockResolvedValueOnce({
                category: "IRRELEVANT", source: "", target: "",
                estimated_time: "", reasoning: "time-bearing fragment",
            });

        await processMessage("channel-1", "שיגורים מאיראן", callbacks, 801, Date.now());
        await processMessage("channel-2", "מרכז 10:30", callbacks, 802, Date.now());

        const events = Object.values(getActiveEvents());
        expect(events).toHaveLength(1);
        expect(events[0].target).toBe("");
        expect(events[0].messages).toHaveLength(1);
        expect(callbacks.alert).not.toHaveBeenCalled();
    });

    test("does not attach a region follow-up to a stale source-only event", async () => {
        classifyMessage
            .mockResolvedValueOnce({
                category: "LAUNCH_REPORT", source: "איראן", target: "",
                estimated_time: "", reasoning: "source-only report",
            })
            .mockResolvedValueOnce({
                category: "IRRELEVANT", source: "", target: "",
                estimated_time: "", reasoning: "orphan region",
            });

        await processMessage("channel-1", "שיגורים מאיראן", callbacks, 811, Date.now());
        Object.values(getActiveEvents())[0].lastSeen = Date.now() - 10 * 60 * 1000;
        await processMessage("channel-2", "מרכז", callbacks, 812, Date.now());

        expect(Object.values(getActiveEvents())).toHaveLength(0);
        expect(callbacks.alert).not.toHaveBeenCalled();
    });

    test("does not attach a region follow-up when the candidate already has a target", async () => {
        classifyMessage
            .mockResolvedValueOnce({
                category: "LAUNCH_REPORT", source: "איראן", target: "צפון",
                estimated_time: "", reasoning: "complete report",
            })
            .mockResolvedValueOnce({
                category: "IRRELEVANT", source: "", target: "",
                estimated_time: "", reasoning: "different region fragment",
            });

        await processMessage("channel-1", "שיגורים מאיראן לצפון", callbacks, 821, Date.now());
        await processMessage("channel-2", "מרכז", callbacks, 822, Date.now());

        const events = Object.values(getActiveEvents());
        expect(events).toHaveLength(1);
        expect(events[0].target).toBe("צפון");
        expect(events[0].messages).toHaveLength(1);
        expect(callbacks.alert).not.toHaveBeenCalled();
    });

    test("does not add duplicate region-fragment evidence when Telegram retries the same message ID", async () => {
        classifyMessage
            .mockResolvedValueOnce({
                category: "LAUNCH_REPORT", source: "איראן", target: "",
                estimated_time: "", reasoning: "source-only report",
            })
            .mockResolvedValueOnce({
                category: "IRRELEVANT", source: "", target: "",
                estimated_time: "", reasoning: "region-only fragment",
            })
            .mockResolvedValueOnce({
                category: "IRRELEVANT", source: "", target: "",
                estimated_time: "", reasoning: "duplicate delivery",
            });

        await processMessage("channel-1", "שיגורים מאיראן", callbacks, 831, Date.now());
        await processMessage("channel-2", "מרכז", callbacks, 832, Date.now());

        const eventBeforeRetry = Object.values(getActiveEvents())[0];
        const lastSeenBeforeRetry = eventBeforeRetry.lastSeen;
        const targetBeforeRetry = eventBeforeRetry.target;
        await processMessage("channel-2", "מרכז", callbacks, 832, Date.now());

        const events = Object.values(getActiveEvents());
        expect(events).toHaveLength(1);
        expect(events[0].messages.filter(message => message.messageId === 832)).toHaveLength(1);
        expect(events[0].channels.size).toBe(2);
        expect(events[0].lastSeen).toBe(lastSeenBeforeRetry);
        expect(events[0].target).toBe(targetBeforeRetry);
        expect(callbacks.alert).not.toHaveBeenCalled();
    });

    test("does not treat a standalone region as an alert when no source-only event exists", async () => {
        classifyMessage.mockResolvedValue({
            category: "IRRELEVANT", source: "", target: "", estimated_time: "",
            reasoning: "orphan region fragment",
        });

        await processMessage("channel-1", "מרכז", callbacks, 841, Date.now());

        expect(Object.values(getActiveEvents())).toHaveLength(0);
        expect(callbacks.alert).not.toHaveBeenCalled();
    });

    test("a processing error is not acknowledged as an irrelevant message", async () => {
        classifyMessage.mockResolvedValue({ category: "PROCESSING_ERROR", retryable: true, reasoning: "API unavailable" });
        const result = await processMessage("channel-1", "report", callbacks, 101, 1767254400);
        expect(result).toBe(false);
        expect(callbacks.alert).not.toHaveBeenCalled();
        expect(callbacks.update).not.toHaveBeenCalled();
    });

    test("updates require corroboration from two channels", async () => {
        setLastPublished("איראן", "מרכז", "10:00");
        classifyMessage.mockResolvedValue({
            category: "UPDATE_TO_LAST",
            reasoning: "new target",
            source: "איראן",
            target: "מרכז, צפון",
            estimated_time: "10:15",
            event_key: "איראן->מרכז, צפון",
        });

        await processMessage("channel-1", "update-1", callbacks, 111, 1767254400);
        expect(callbacks.update).not.toHaveBeenCalled();
        await processMessage("channel-2", "update-2", callbacks, 222, 1767254400);
        expect(callbacks.update).toHaveBeenCalledTimes(1);
    });
});
