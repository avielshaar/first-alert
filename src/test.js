/**
 * REAL-WORLD CHAOS TEST SUITE (Time-Series & Multi-Channel)
 * Configured with 4.5s API delay and a Time-Travel Simulator.
 */

require("dotenv").config(); 
const processor = require("./messaging/processor");
const config = require("./config");

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

const CH_ALMOG = "-1001111111111"; // ערוץ מהיר אבל פחות מדויק
const CH_AMIT = "-1002222222222";  // ערוץ איטי אבל מדויק
const CH_NEWS = "-1003333333333";  // ערוץ חדשות ממסדי (נוטה לחפרנות)
const CH_SPAM = "-1004444444444";  // ערוץ חובבני מלא ספאם

// ==========================================
// Time Travel Simulator (מכונת הזמן)
// ==========================================
const originalDateNow = Date.now;
let simulatedTime = originalDateNow();

function startSimulation() {
    simulatedTime = originalDateNow();
    Date.now = () => simulatedTime; // עוקף את השעון של Node.js
}

function advanceTime(minutes) {
    simulatedTime += minutes * 60 * 1000;
    const timeStr = new Date(simulatedTime).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`\n${CYAN}⏳ [Time Travel] Fast-forwarded ${minutes} minutes. Current simulated time: ${timeStr}${RESET}`);
}

function stopSimulation() {
    Date.now = originalDateNow;
}

// ==========================================
// Test Utilities
// ==========================================
function getProc() {
    for (const key of Object.keys(processor.getActiveEvents())) {
        delete processor.getActiveEvents()[key];
    }
    processor.setLastPublished(null, null, null);
    return processor;
}

function makeCallbacks(proc) {
    return {
        publishedData: null,
        publishedUpdate: null,
        alertCount: 0,
        updateCount: 0,
        async alert(source, target, estimated_time) {
            this.publishedData = { source, target, estimated_time };
            this.alertCount++;
            proc.setLastPublished(source, target, estimated_time);
        },
        async update(newData, oldData, updateType) {
            this.publishedUpdate = newData;
            this.updateCount++;
            proc.setLastPublished(newData.source, newData.target, newData.estimated_time);
        },
        checkCallCounts(expectedAlerts, expectedUpdates) {
            if (this.alertCount === expectedAlerts && this.updateCount === expectedUpdates) {
                console.log(`${GREEN}  ✓ PASS — Triggered exactly ${expectedAlerts} Alerts and ${expectedUpdates} Updates.${RESET}`);
                passed++;
            } else {
                console.log(`${RED}  ✗ FAIL — Expected ${expectedAlerts} Alerts, ${expectedUpdates} Updates. Got: ${this.alertCount} Alerts, ${this.updateCount} Updates.${RESET}`);
                failed++;
            }
        },
        checkExactData(field, exactString, checkUpdate = false) {
            const dataObj = checkUpdate ? this.publishedUpdate : this.publishedData;
            const val = dataObj?.[field] || "";
            if (val === exactString) {
                console.log(`${GREEN}  ✓ PASS — ${field} accurately mapped to "${exactString}"${RESET}`);
                passed++;
            } else {
                console.log(`${RED}  ✗ FAIL — ${field} expected "${exactString}", got "${val}"${RESET}`);
                failed++;
            }
        }
    };
}

async function sendMsg(proc, channel, text, cb) {
    console.log(`[Msg] Channel ${channel.slice(-4)}: "${text}"`);
    await proc.processMessage(channel, text, cb);
    await new Promise(r => setTimeout(r, 4500)); // מניעת חסימת 429 מגוגל
}

async function runScenario(name, scenarioFn) {
    console.log(`\n${YELLOW}▶ Running Scenario: ${name}${RESET}`);
    startSimulation();
    try {
        await scenarioFn();
    } catch (err) {
        console.log(`${RED}  ✗ ERROR — Scenario crashed: ${err.message}${RESET}`);
        failed++;
    }
    stopSimulation();
}

async function main() {
    console.log("🌪️ Starting Real-World Chaos Test Suite...");
    console.log("⏳ API Delay active (4.5s). Time-travel active.\n");

    // =========================================================
    // SCENARIO 1: The "Fog of War" (Fragmented Intelligence)
    // ערוצים מדווחים חלקי מידע בזמנים שונים. המערכת צריכה לאסוף
    // את הפאזל ולירות התרעה רק כשיש לה מספיק ודאות.
    // =========================================================
    await runScenario("01. Fog of War (Piece by Piece)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        
        // ערוץ א' מדווח רק על מקור
        await sendMsg(proc, CH_ALMOG, "🚨 דיווח ראשוני: שיגורים מתימן", cb);
        cb.checkCallCounts(0, 0); // לא שולחים כי יש רק ערוץ אחד
        
        advanceTime(2); // עברו 2 דקות ארוכות
        
        // ערוץ ספאם מפריע באמצע
        await sendMsg(proc, CH_SPAM, "מישהו שמע בומים?", cb);
        cb.checkCallCounts(0, 0);
        
        // ערוץ ב' מדווח על היעד בלבד
        await sendMsg(proc, CH_AMIT, "רקטות בדרך לאילת", cb);
        
        // עכשיו יש לנו 2 ערוצים. ערוץ א' אמר תימן, ערוץ ב' אמר אילת.
        // ה-Processor צריך לחבר את זה לאירוע אחד (תימן -> אילת).
        cb.checkCallCounts(1, 0); 
        cb.checkExactData("source", "תימן");
        cb.checkExactData("target", "אילת");
    });

    // =========================================================
    // SCENARIO 2: Context Window Expiry (Memory Wipe)
    // בדיקה קריטית: ערוץ מדווח משהו. עוברת חצי שעה (יותר מהחלון).
    // ערוץ אחר מדווח משהו דומה. הבוט *לא* אמור לחבר ביניהם!
    // =========================================================
    await runScenario("02. Context Window Expiration (No Ghost Corroboration)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        
        await sendMsg(proc, CH_ALMOG, "🚨 ירי מעזה לדרום", cb);
        cb.checkCallCounts(0, 0); // רק ערוץ 1
        
        advanceTime(25); // קפיצה של 25 דקות (מנקה את הזיכרון של הבוט)
        
        await sendMsg(proc, CH_AMIT, "אזעקות בעוטף ובדרום", cb);
        
        // למרות שיש פה 2 דיווחים על ירי לדרום, הם בהפרש של 25 דקות.
        // הבוט אמור למחוק את הדיווח הראשון ולראות בשני אירוע חדש ללא אימות.
        cb.checkCallCounts(0, 0); 

        // עכשיו באותו זמן של האירוע החדש, ערוץ נוסף מאשר:
        await sendMsg(proc, CH_NEWS, "מטחים מרצועת עזה לעבר הדרום", cb);
        cb.checkCallCounts(1, 0); // עכשיו האירוע החדש אושר
    });

    // =========================================================
    // SCENARIO 3: The Multi-Front Barrage
    // מתקפה מקבילה מחיזבאללה ואיראן. הבוט חייב לפצל את האירועים
    // ולהוציא 2 התרעות שונות, ולא לעשות סלט ערים.
    // =========================================================
    await runScenario("03. Simultaneous Multi-Front Attack", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        
        await sendMsg(proc, CH_ALMOG, "🚨 שיגורים מלבנון", cb);
        await sendMsg(proc, CH_AMIT, "🚨 טילים מאיראן בדרך לישראל", cb);
        advanceTime(1);
        await sendMsg(proc, CH_NEWS, "התרעות הופעלו בצפון עקב ירי מלבנון", cb);
        
        // אישור לאירוע 1 (לבנון)
        cb.checkCallCounts(1, 0);
        cb.checkExactData("source", "לבנון");
        cb.checkExactData("target", "צפון");

        // ממשיכים את האירוע של איראן
        await sendMsg(proc, CH_SPAM, "האיראנים בדרך אלינו לגוש דן ולתל אביב", cb); // ספאם צודק הפעם
        
        // אישור לאירוע 2 (איראן)
        cb.checkCallCounts(2, 0); // Alert count עולה ל-2
        cb.publishedData = cb.publishedData; // Refresh ptr
        cb.checkExactData("source", "איראן");
        cb.checkExactData("target", "מרכז"); // גוש דן ות"א מופו למרכז נקי
    });

    // =========================================================
    // SCENARIO 4: The Update Storm (Deduplication Stress Test)
    // התרעה פורסמה. עכשיו 4 ערוצים שונים שולחים עדכונים *זהים*
    // בניסוחים שונים. הבוט חייב לשלוח את העדכון רק פעם אחת לעוקבים.
    // =========================================================
    await runScenario("04. Update Storm & Deduplication", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        
        // התרעה ראשונית מהירה
        await sendMsg(proc, CH_ALMOG, "איראן ירתה למרכז", cb);
        await sendMsg(proc, CH_AMIT, "טילים מאיראן לעבר המרכז", cb);
        cb.checkCallCounts(1, 0); // 1 Alert

        advanceTime(3);

        // מבול עדכונים - כולם אומרים שהטווח התרחב גם לשרון ולשפלה.
        // הבוט צריך לתפוס את הראשון, ולהתעלם מכל השאר.
        await sendMsg(proc, CH_NEWS, "עדכון: איראן מכוונת גם לשרון ולשפלה", cb); // ישלח עדכון
        await sendMsg(proc, CH_ALMOG, "אזעקות גם באזור השרון והשפלה", cb); // אמור להיחסם
        await sendMsg(proc, CH_AMIT, "הטווח התרחב: מרכז, שרון, שפלה", cb); // אמור להיחסם
        await sendMsg(proc, CH_SPAM, "כל אזור המרכז השרון והשפלה במקלטים!!", cb); // אמור להיחסם

        cb.checkCallCounts(1, 1); // רק ONE update עבר!
        cb.checkExactData("target", "מרכז, שפלה, שרון", true); // ממוין אלפביתית וממוזג
    });

    // =========================================================
    // SCENARIO 5: The Daily Summary (False Positive Trap)
    // בסוף היום, ערוץ חדשות מעלה סיכום אירועים. יש שם מילות
    // תקיפה, יעדים ומקורות. ה-AI חייב להבין שזה עבר.
    // =========================================================
    await runScenario("05. The Daily Summary Trap", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        
        const summaryText = `
        סיכום אירועי היום:
        - 40 רקטות שוגרו מלבנון לעבר הצפון.
        - כטב"ם שיורט מעל אילת לאחר ששוגר מתימן.
        - תקיפות צה"ל בדרום לבנון.
        שיהיה לילה שקט.`;

        await sendMsg(proc, CH_NEWS, summaryText, cb);
        await sendMsg(proc, CH_AMIT, "סיכום ירי: מלבנון לצפון", cb);

        cb.checkCallCounts(0, 0); // לא שוגרה שום התרעה! ה-AI זיהה כוונת דיווח היסטורי.
    });

    console.log(`\n===========================================`);
    console.log(`      REAL-WORLD CHAOS TEST SUMMARY        `);
    console.log(`===========================================`);
    console.log(`${GREEN}  PASSED: ${passed}${RESET}`);
    if (failed > 0) {
        console.log(`${RED}  FAILED: ${failed}${RESET}`);
    } else {
        console.log(`${GREEN}  ALL REAL-WORLD SCENARIOS PASSED! 🌍🔥🤖${RESET}`);
    }
    process.exit(failed > 0 ? 1 : 0);
}

main();