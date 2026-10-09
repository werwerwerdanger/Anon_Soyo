// Verify that the proactive-search patch is syntactically valid AND actually
// shows up in the text handed to the tool-decision phase.
//
// Run:  node verify_hint.mjs
import { pathToFileURL } from "node:url";

const TARGETS = [
    "C:/Users/20633/MimirLink/src/tools.js",
    "C:/Users/20633/MimirLink-soyo/src/tools.js",
];

const cfg = {
    ai: {
        tools: {
            webSearch: {
                enabled: true,
                maxResults: 5,
                fetch: { enabled: true },
                spice: { enabled: true },
            },
        },
    },
};

let ok = true;
for (const target of TARGETS) {
    const label = target.split("/")[3];
    try {
        const mod = await import(pathToFileURL(target).href);
        const hint = mod.buildWebToolHint(cfg);
        const hasProactive = hint.includes("主动检索要求");
        const hasDefaultFirst = hint.includes("默认先查证再回答");
        const hasNoSearchCases = hint.includes("不必检索的情形");
        console.log(`\n== ${label}`);
        console.log(`   import        : OK`);
        console.log(`   hint length   : ${hint.length} chars`);
        console.log(`   proactive block: ${hasProactive ? "PRESENT" : "MISSING"}`);
        console.log(`   default-first  : ${hasDefaultFirst ? "PRESENT" : "MISSING"}`);
        console.log(`   no-search rules: ${hasNoSearchCases ? "PRESENT" : "MISSING"}`);
        if (!hasProactive || !hasDefaultFirst || !hasNoSearchCases) ok = false;
    } catch (e) {
        ok = false;
        console.log(`\n== ${label}`);
        console.log(`   FAILED: ${e.message}`);
    }
}

// also prove the tool phase really drops system messages (the root cause)
console.log("\n== root-cause recheck: does the tool phase drop system messages?");
try {
    const mod = await import(pathToFileURL(TARGETS[0]).href);
    // Use a unique marker: the tool_scene text itself contains the word 人设
    // ("不需要扮演或输出人设内容"), so matching on that phrase gives a false YES.
    const MARKER = "CHAR_CARD_MARKER_7f3a";
    const full = [
        { role: "system", content: MARKER },
        { role: "user", content: "今天天气怎么样" },
    ];
    const built = mod.buildToolPhaseMessages(full, ["【功能：联网检索】test"], {
        characterName: "Anon",
        chatScope: "private|10001|Anon",
    });
    const roles = built.map((m) => m.role + (m.meta?.source ? `(${m.meta.source})` : ""));
    const survived = built.some((m) => String(m.content).includes(MARKER));
    console.log(`   input  roles : ${full.map((m) => m.role).join(", ")}`);
    console.log(`   output roles : ${roles.join(", ")}`);
    console.log(`   character-card message survived? ${survived ? "YES" : "NO -> CONFIRMS the drop"}`);
    if (survived) ok = false;
} catch (e) {
    console.log(`   recheck failed: ${e.message}`);
}

console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
