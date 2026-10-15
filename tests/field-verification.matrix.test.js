const { getCorroboratedFields } = require("../src/domain/field-verification");

const SOURCES = ["", "איראן", "לבנון"];
const TARGETS = ["", "מרכז", "דרום"];
const TIMES = ["", "10:00", "10:10"];

function expectedTime(left, right) {
    if (!left || !right) return "";
    if (left === right) return left;
    return left < right ? left + "–" + right : right + "–" + left;
}

describe("field-verification combination matrix", () => {
    test("all 729 two-channel source × target × ETA combinations verify only supported fields", () => {
        let combinations = 0;

        for (const sourceA of SOURCES) {
            for (const targetA of TARGETS) {
                for (const timeA of TIMES) {
                    for (const sourceB of SOURCES) {
                        for (const targetB of TARGETS) {
                            for (const timeB of TIMES) {
                                const event = {
                                    messages: [
                                        {
                                            channel: "channel-A",
                                            reportedSource: sourceA,
                                            reportedTarget: targetA,
                                            reportedEstimatedTime: timeA,
                                            time: 1,
                                        },
                                        {
                                            channel: "channel-B",
                                            reportedSource: sourceB,
                                            reportedTarget: targetB,
                                            reportedEstimatedTime: timeB,
                                            time: 2,
                                        },
                                    ],
                                };

                                expect(getCorroboratedFields(event)).toEqual({
                                    source: sourceA && sourceA === sourceB ? sourceA : "",
                                    target: targetA && targetA === targetB ? targetA : "",
                                    estimated_time: expectedTime(timeA, timeB),
                                });
                                combinations++;
                            }
                        }
                    }
                }
            }
        }

        expect(combinations).toBe(729);
    });

    test("repeating every field in one channel still provides zero independent confirmations", () => {
        for (const source of SOURCES) {
            for (const target of TARGETS) {
                for (const time of TIMES) {
                    const event = {
                        messages: [
                            {
                                channel: "channel-A",
                                reportedSource: source,
                                reportedTarget: target,
                                reportedEstimatedTime: time,
                                time: 1,
                            },
                            {
                                channel: "channel-A",
                                reportedSource: source,
                                reportedTarget: target,
                                reportedEstimatedTime: time,
                                time: 2,
                            },
                        ],
                    };

                    expect(getCorroboratedFields(event)).toEqual({
                        source: "",
                        target: "",
                        estimated_time: "",
                    });
                }
            }
        }
    });
});
