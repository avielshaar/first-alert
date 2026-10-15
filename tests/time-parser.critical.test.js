// Regression and edge-case tests for the deterministic ETA parser.
process.env.GEMINI_API_KEY = "test-key";

const { extractTime } = require("../src/messaging/classifier");

const atTenAm = new Date("2026-01-01T10:00:00+02:00");

describe("extractTime — ETA parsing and ambiguous input", () => {
    test.each([
        ["בעוד דקה", "10:01"],
        ["בעוד 1 דקה", "10:01"],
        ["בעוד 10 דקות", "10:10"],
        ["תוך 5 דקות", "10:05"],
        ["עוד עשר דקות", "10:10"],
        ["בתוך כ-5 דקות", "10:05"],
        ["זמן הגעה: 10 דקות", "10:10"],
        ["זמן הגעה בעוד 10 דקות", "10:10"],
        ["זמן הגעה משוער: עשר דקות", "10:10"],
        ["יגיע בעוד 5 דקות", "10:05"],
        ["צפוי להגיע תוך 20 דקות", "10:20"],
        ["בעוד שעה", "11:00"],
        ["בעוד שעתיים", "12:00"],
        ["בעוד 2 שעות", "12:00"],
        ["בעוד חצי שעה", "10:30"],
        ["בעוד רבע שעה", "10:15"],
        ["בעוד שעה וחצי", "11:30"],
        ["בעוד שעתיים וחצי", "12:30"],
        ["בעוד שעה ורבע", "11:15"],
        ["בעוד שעתיים ורבע", "12:15"],
        ["בעוד 2.5 שעות", "12:30"],
        ["בעוד 5 דק׳", "10:05"],
    ])("parses future ETA %s as %s", (message, expected) => {
        expect(extractTime(message, atTenAm)).toBe(expected);
    });

    test.each([
        "לפני 10 דקות",
        "הירי התחיל לפני 5 דקות",
        "עברו 10 דקות",
        "חלפו 2 שעות",
        "האירוע קרה לפני שעה וחצי",
        "זמן הגעה: לפני 10 דקות",
    ])("does not turn past/elapsed duration into a future ETA: %s", message => {
        expect(extractTime(message, atTenAm)).toBe("");
    });

    test("uses the Telegram message timestamp, not processing time, for a relative ETA", () => {
        const telegramTimestampSeconds = atTenAm.getTime() / 1000;
        expect(extractTime("בעוד 10 דקות", telegramTimestampSeconds)).toBe("10:10");
    });

    test("handles midnight rollover using Israel local time", () => {
        const lateNight = new Date("2026-01-01T23:55:00+02:00");
        expect(extractTime("בעוד 10 דקות", lateNight)).toBe("00:05");
    });

    test.each([
        ["זמן הגעה: 22:30", "22:30"],
        ["דווח ב-09:00, הגעה משוערת ב-10:30", "10:30"],
        ["הודעה נשלחה ב-09:00; זמן הגעה משוער: 10:30", "10:30"],
        ["צפוי להגיע בשעה 10:30", "10:30"],
        ["שיגור דווח בשעה 09:00, צפי הגעה 10:30", "10:30"],
        ["הזמן המשוער הוא 9:05", "09:05"],
        ["השיגור יגיע ב-22:30", "22:30"],
    ])("extracts the ETA-associated absolute time in %s", (message, expected) => {
        expect(extractTime(message, atTenAm)).toBe(expected);
    });

    test("preserves backward compatibility for one unlabelled absolute clock time", () => {
        expect(extractTime("שעת דיווח 22:30", atTenAm)).toBe("22:30");
    });

    test.each([
        "דווח ב-09:00, אחר כך עודכן ב-10:30",
        "זמן הגעה 10:30; הגעה משוערת 10:45",
        "בעוד 5 דקות ואז בעוד 10 דקות",
    ])("omits ambiguous times instead of selecting one arbitrarily: %s", message => {
        expect(extractTime(message, atTenAm)).toBe("");
    });

    test("prefers an explicit ETA over an unrelated report timestamp", () => {
        expect(extractTime("דווח ב-09:00; צפוי להגיע בעוד 10 דקות", atTenAm)).toBe("10:10");
    });

    test("uses an unambiguous relative ETA even when an unrelated absolute time is present", () => {
        expect(extractTime("הודעה נשלחה ב-09:00; הגעה תוך 5 דקות", atTenAm)).toBe("10:05");
    });

    test.each([
        "אין שעה מפורשת בהודעה",
        "הגעה בשעה 25:61",
        "הגעה בשעה 24:00",
    ])("returns an empty ETA when no valid clock time or future duration exists: %s", message => {
        expect(extractTime(message, atTenAm)).toBe("");
    });
});
