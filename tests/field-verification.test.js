const {
    getCorroboratedFields,
    getPendingUncorroboratedFields,
} = require("../src/domain/field-verification");

describe("field verification domain", () => {
    test("confirms fields only when two independent channels support them", () => {
        const event = {
            messages: [
                { channel: "a", reportedSource: "Iran", reportedTarget: "North", reportedEstimatedTime: "", time: 1 },
                { channel: "a", reportedSource: "Iran", reportedTarget: "North", reportedEstimatedTime: "", time: 2 },
            ],
        };
        expect(getCorroboratedFields(event)).toEqual({ source: "", target: "", estimated_time: "" });
    });

    test("corroborates source and target across channels and handles midnight ETA", () => {
        const event = {
            messages: [
                { channel: "a", reportedSource: "Iran", reportedTarget: "North", reportedEstimatedTime: "23:59", time: 1 },
                { channel: "b", reportedSource: "Iran", reportedTarget: "North", reportedEstimatedTime: "00:02", time: 2 },
            ],
        };
        expect(getCorroboratedFields(event)).toEqual({
            source: "Iran",
            target: "North",
            estimated_time: "00:01",
        });
    });

    test("reports fields that have only one channel of evidence as pending", () => {
        const event = {
            messages: [
                { channel: "a", reportedSource: "Iran", reportedTarget: "North", reportedEstimatedTime: "", time: 1 },
            ],
        };
        expect(getPendingUncorroboratedFields(event, null)).toEqual(["source", "target"]);
    });
});
