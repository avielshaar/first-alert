const { log, formatTimestamp, inferLevel } = require("../src/utils/logger");

describe("centralized logger", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test("formats timestamps with date and time in the configured timezone", () => {
        expect(formatTimestamp(new Date("2026-10-14T10:32:51.000Z")))
            .toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    test("infers useful severity levels for operational outcomes", () => {
        expect(inferLevel("[Processor] Processing failed; message will be retried.")).toBe("ERROR");
        expect(inferLevel("[Verification] Waiting for independent confirmation.")).toBe("WARN");
        expect(inferLevel("[Telegram] Received message.")).toBe("INFO");
    });

    test("prints one consistent timestamp, severity and message format", () => {
        const output = jest.spyOn(console, "log").mockImplementation(() => {});

        log("[Correlation] event=event-1 action=CREATE_EVENT");
        log("[Dispatch] Delivery failed.", "ERROR");

        expect(output).toHaveBeenNthCalledWith(
            1,
            expect.stringMatching(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[INFO\] \[Correlation\] event=event-1 action=CREATE_EVENT$/)
        );
        expect(output).toHaveBeenNthCalledWith(
            2,
            expect.stringMatching(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[ERROR\] \[Dispatch\] Delivery failed\.$/)
        );
    });
});
