/**
 * True Hybrid Classification Module (AI Intent + Deterministic Data)
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { log } = require("../utils/logger");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

const STRICT_BLACKLIST = [
    "חזלש", "חזל\"ש", "שווא", "תרגיל", "יירוט מוצלח", "יורטו", "יורט", 
    "הוסר החשש", "אין סכנה", "נפילה", "שריפה", "נפגעים", "פצועים", 
    "הרוגים", "כשל", "נפל בים", "כטב\"ם", "כטבם", "רחפן", "חדירת כלי טיס",
    "פינוי", "תיעוד", "השמדת", "חיסול", "דובר צה\"ל", "תקיפות", "גל תקיפות",
    "חיל האוויר תוקף", "צה\"ל תוקף", "נתקף", "פגיעה ישירה"
];

const LAUNCH_WHITELIST = [
    "שיגור", "שיגורים", "ירי", "מטח", "מטחים", "טילים", "רקטות", 
    "בדרך ל", "לעבר", "התרעה", "אזעקה", "התרעות", "הופעלו", "אישור", "דיווח"
];

const SOURCES = [
    { base: "איראן", keywords: ["איראן", "איראנים"] },
    { base: "לבנון", keywords: ["לבנון"] },
    { base: "סוריה", keywords: ["סוריה"] },
    { base: "תימן", keywords: ["תימן"] },
    { base: "עיראק", keywords: ["עיראק"] },
    { base: "עזה", keywords: ["עזה", "רצועת"] }
];

const REGION_MAP = [
    { base: "מרכז", aliases: ["מרכז", "גוש דן", "תל אביב", "ת\"א", "הרצליה"] },
    { base: "דרום", aliases: ["דרום", "עוטף", "באר שבע", "ב\"ש", "אשדוד", "אשקלון"] },
    { base: "צפון", aliases: ["צפון", "קריות", "עכו", "נהריה", "צפת", "טבריה", "מירון"] },
    { base: "ירושלים", aliases: ["ירושלים", "י-ם"] },
    { base: "יו\"ש", aliases: ["יו\"ש", "יו״ש", "יהודה ושומרון", "שומרון", "בנימין"] },
    { base: "שרון", aliases: ["שרון", "נתניה", "חדרה"] },
    { base: "שפלה", aliases: ["שפלה", "ראשון לציון", "רחובות", "ראשל\"צ"] },
    { base: "אילת", aliases: ["אילת", "העיר אילת"] },
    { base: "חיפה", aliases: ["חיפה", "מפרץ חיפה"] },
    { base: "ערבה", aliases: ["ערבה"] },
    { base: "נגב", aliases: ["נגב"] },
    { base: "גליל", aliases: ["גליל", "גליל עליון", "גליל מערבי"] },
    { base: "גולן", aliases: ["גולן", "רמת הגולן"] }
];

async function callAIWithRetry(prompt, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await model.generateContent(prompt);
        } catch (error) {
            if (error.message.includes("503") || error.message.includes("429")) {
                log(`[AI] ⚠️ Google API busy (Error ${error.message.includes("503") ? "503" : "429"}). Retrying ${attempt}/${maxRetries} in 3 seconds...`);
                if (attempt === maxRetries) throw error;
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }
            throw error;
        }
    }
}

function mergeAndCleanTargets(oldStr, newStr) {
    const arr1 = (oldStr || "").split(",").map(s => s.trim()).filter(Boolean);
    const arr2 = (newStr || "").split(",").map(s => s.trim()).filter(Boolean);
    let merged = [...new Set([...arr1, ...arr2])];
    merged = merged.filter(item => {
        return !merged.some(other => other !== item && other.includes(item));
    });
    return merged.sort().join(", ");
}

function extractSource(text) {
    for (const src of SOURCES) {
        for (const kw of src.keywords) {
            const regex = new RegExp(`(?<![\\u0590-\\u05FF])(?:מ|מ-|מאזור\\s|מכיוון\\s)?ה?${kw}(?![\\u0590-\\u05FF])`);
            if (regex.test(text)) return src.base;
        }
    }
    return "";
}

function extractTargets(text) {
    const cleanedText = text.replace(/דרום לבנון/g, "---").replace(/בדרום לבנון/g, "---");
    const found = [];
    for (const region of REGION_MAP) {
        for (const alias of region.aliases) {
            const safeAlias = alias.replace(/"/g, '["״]');
            const regexStr = `(?<![\\u0590-\\u05FF])(?:ו|ול)?(?:ל|ל-|ב|ב-|לעבר\\s|לאזור\\s|באזור\\s|אזור\\s|לכיוון\\s|אל\\s)*ה?${safeAlias}(?![\\u0590-\\u05FF])(?:\\s*\\([^)]+\\))?`;
            const regex = new RegExp(regexStr);
            const match = cleanedText.match(regex);
            if (match) {
                const parenMatch = match[0].match(/\(([^)]+)\)/);
                const parenSuffix = parenMatch ? ` (${parenMatch[1]})` : "";
                found.push(region.base + parenSuffix);
                break;
            }
        }
    }
    return mergeAndCleanTargets("", found.join(", "));
}

function extractTime(text) {
    const now = new Date();
    const absMatch = text.match(/(?<!\d)([0-1]?[0-9]|2[0-3]):([0-5][0-9])(?!\d)/);
    if (absMatch) return `${absMatch[1].padStart(2, '0')}:${absMatch[2]}`;

    const relMatch = text.match(/(?:בעוד|עוד|בתוך|תוך|יגיעו ב|זמן הגעה)?\s*(?:כ-|-)?(\d+|עשר|חמש|חמישה|רבע|עשרים|חצי)\s*(דקות|שעה)/);
    if (relMatch) {
        let numStr = relMatch[1];
        let unit = relMatch[2];
        let mins = parseInt(numStr);
        const numMap = {"עשר": 10, "חמש": 5, "חמישה": 5, "רבע": 15, "עשרים": 20, "חצי": 30};
        if (isNaN(mins)) mins = numMap[numStr] || 0;
        if (unit === "שעה" && numStr === "חצי") mins = 30;
        else if (unit === "שעה" && numStr === "רבע") mins = 15;

        if (mins > 0) {
            now.setMinutes(now.getMinutes() + mins);
            return now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
        }
    }
    return "";
}

async function classifyMessage(channelId, messageText, lastPublished) {
    if (STRICT_BLACKLIST.some(word => messageText.includes(word))) {
        return { category: "IRRELEVANT", reasoning: "Blocked by deterministic blacklist.", event_key: "", source: "", target: "", estimated_time: "" };
    }

    const source = extractSource(messageText);
    const target = extractTargets(messageText);
    const estimatedTime = extractTime(messageText);

    const prompt = `
    Analyze this Telegram message in Hebrew:
    "${messageText}"

    Classify the INTENT of the message into exactly ONE category:
    LAUNCH_REPORT — Explicitly reports a NEW, currently happening, or imminent rocket/missile launch or siren.
    UPDATE_TO_LAST — Provides a tactical update (e.g., new time, expanding target areas) to an ongoing attack.
    IRRELEVANT — Everything else: Casual conversation, past events, interception reports, IDF attacks, news summaries, links, or vague warnings.

    CRITICAL INSTRUCTION: Assume ALL messages are live, real-time reports. Do NOT reject or mark as IRRELEVANT just because an explicit time seems to be in the past. 

    Return ONLY raw JSON, no markdown:
    {
      "category": "LAUNCH_REPORT" or "UPDATE_TO_LAST" or "IRRELEVANT",
      "reasoning": "One short sentence in English explaining why."
    }`;

    let aiCategory = "IRRELEVANT";
    let aiReasoning = "Fell through";

    try {
        const result = await callAIWithRetry(prompt);
        const text = result.response.text();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            aiCategory = parsed.category;
            aiReasoning = parsed.reasoning;
        }
    } catch (err) {
        log("[AI] classifyMessage critical error: " + err.message);
    }

    const hasLaunchWord = LAUNCH_WHITELIST.some(word => messageText.includes(word));

    if (aiCategory !== "IRRELEVANT" && !source && !target && !estimatedTime && !hasLaunchWord) {
        aiCategory = "IRRELEVANT";
        aiReasoning = "AI identified launch, but no tactical data or keywords found. Overridden.";
    }

    if (aiCategory === "IRRELEVANT" && (target || source) && messageText.length <= 25) {
        aiCategory = "LAUNCH_REPORT";
        aiReasoning = "Overridden by deterministic: Short ping with valid tactical target/source.";
    }

    if (aiCategory === "UPDATE_TO_LAST" && lastPublished) {
        const isDifferentSource = source && lastPublished.source && source !== lastPublished.source;
        if (isDifferentSource) {
            aiCategory = "LAUNCH_REPORT"; 
            aiReasoning = "Deterministic override: Source mismatch, changing UPDATE to new LAUNCH_REPORT.";
        }
    }

    if (aiCategory === "UPDATE_TO_LAST" || (aiCategory === "LAUNCH_REPORT" && lastPublished)) {
        if (lastPublished && aiCategory === "UPDATE_TO_LAST") {
             let mergedTargets = mergeAndCleanTargets(lastPublished.target, target);
             let isNewTarget = target && mergedTargets !== lastPublished.target;
             let isNewTime = estimatedTime && estimatedTime !== lastPublished.estimated_time;

             if (isNewTarget || isNewTime) {
                 return {
                     category: "UPDATE_TO_LAST",
                     reasoning: aiReasoning,
                     source: source || lastPublished.source,
                     target: mergedTargets,
                     estimated_time: estimatedTime || lastPublished.estimated_time,
                     event_key: `${source || lastPublished.source}->${mergedTargets}`
                 };
             } else if (target === lastPublished.target && (!estimatedTime || estimatedTime === lastPublished.estimated_time)) {
                 return { category: "IRRELEVANT", reasoning: "Duplicate update info.", event_key: "", source: "", target: "", estimated_time: "" };
             }
        }
    }

    if (aiCategory === "LAUNCH_REPORT") {
        if (target || source) {
            return {
                category: "LAUNCH_REPORT",
                reasoning: aiReasoning,
                source: source,
                target: target,
                estimated_time: estimatedTime,
                event_key: `${source}->${target}`
            };
        }
    }

    return { category: "IRRELEVANT", reasoning: aiReasoning, event_key: "", source: "", target: "", estimated_time: "" };
}

async function checkForNewInfo(newMessages, lastPublished) {
    if (!lastPublished) return { has_new_info: false };

    const combinedText = newMessages.map(m => m.text).join(" | ");
    
    if (STRICT_BLACKLIST.some(word => combinedText.includes(word))) {
        return { has_new_info: false, reasoning: "Blocked by deterministic blacklist." };
    }

    const target = extractTargets(combinedText);
    const estimatedTime = extractTime(combinedText);
    const source = extractSource(combinedText);

    if (source && lastPublished.source && source !== lastPublished.source) {
        return { 
            has_new_info: true, 
            source: source, 
            target: target, 
            estimated_time: estimatedTime, 
            reasoning: "Different source, cross-event. Treating as new alert." 
        };
    }

    let hasNew = false;
    let finalTarget = lastPublished.target || "";
    let finalTime = lastPublished.estimated_time || "";
    let finalSource = lastPublished.source || "";

    let mergedTargets = mergeAndCleanTargets(finalTarget, target);
    if (target && mergedTargets !== finalTarget) {
        hasNew = true;
        finalTarget = mergedTargets;
    }

    if (estimatedTime && estimatedTime !== finalTime) {
        hasNew = true;
        finalTime = estimatedTime;
    }

    return {
        has_new_info: hasNew,
        source: source || finalSource,
        target: finalTarget,
        estimated_time: finalTime,
        reasoning: hasNew ? "Deterministic logic found new info." : "No new actionable info."
    };
}

module.exports = { 
    classifyMessage, 
    checkForNewInfo, 
    extractTargets, 
    extractTime, 
    mergeAndCleanTargets 
};