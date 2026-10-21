/**
 * The chat system prompt is trimmed per request: reference sections for features nobody has mentioned are left out, the rules every
 * request needs are always sent, and a section is either sent whole or not at all.
 *
 *     node scripts/tests/prompt-selection.test.cjs
 */
const { makeLoader, reporter } = require("./_harness.cjs");
const { check, finish } = reporter();

const load = makeLoader({});
const { buildSystemPrompt } = load("src/lib/ai/system-prompt.ts");
const { conversationTopics } = load("src/lib/ai/window-messages.ts");

const has = (p, heading) => p.split(String.fromCharCode(10)).some((l) => l.startsWith("## " + heading));
const headings = (p) => p.split(String.fromCharCode(10)).filter((l) => l.startsWith("## "));

const full = buildSystemPrompt({ userName: "Ada" });
const webHello = buildSystemPrompt({ userName: "Ada", topicText: "hello there" });
const appHello = buildSystemPrompt({ userName: "Ada", client: "expo-android", topicText: "what is my balance" });
const appFull = buildSystemPrompt({ userName: "Ada", client: "expo-android" });

check("no topic text: the whole prompt is sent, unchanged", has(full, "Fuze Finance") && has(full, "Bluvfi for Business") && has(full, "xStocks"));
check("a greeting drops the big reference sections", !has(webHello, "Fuze Finance") && !has(webHello, "SpherePay") && !has(webHello, "xStocks") && !has(webHello, "Nosana GPU Cloud"));
check("a greeting is much smaller than the full prompt", webHello.length < full.length * 0.6);
check("the rules every request needs are always sent", ["Personality", "What you can do", "Wallet network rules", "Payment rules", "Bills / Digital products workflow", "Wallet routing", "User context"].every((h) => has(webHello, h) && has(appHello, h)));
check("the user's own details are still sent", webHello.includes("Name: Ada"));

const topics = {
  "buy 5 NVDA stock": ["Investments", "xStocks"],
  "pay with XRP": ["XRP wallet & payments"],
  "what is the price of btc": ["Live crypto market data"],
  "send a payout to my bank": ["Fuze Finance", "SpherePay", "Banking payout suite"],
  "search for a domain on doma": ["Doma Protocol"],
  "I want an esim for Ghana": ["Cryptorefills"],
  "buy gold": ["Gold trading"],
  "rent a GPU on nosana": ["Nosana GPU Cloud"],
  "pay with x402": ["Unified x402"],
  "my business treasury": ["Bluvfi for Business"],
};
for (const [text, want] of Object.entries(topics)) {
  const p = buildSystemPrompt({ userName: "Ada", topicText: text });
  check(`"${text}" brings in ${want.join(", ")}`, want.every((h) => has(p, h)));
}

check("a short word does not match inside another word (eth in method, sol in solve)", !has(buildSystemPrompt({ topicText: "which method will solve this" }), "Live crypto market data"));
check("a word start still matches (investing, tokenized)", has(buildSystemPrompt({ topicText: "I am investing" }), "Investments"));

check("the app never gets the Business section, even when asked", !has(buildSystemPrompt({ client: "expo-android", topicText: "business treasury payee invoice" }), "Bluvfi for Business"));
check("the app prompt is trimmed even without topic text for website-only sections", !has(appFull, "Bluvfi for Business") && has(appFull, "Fuze Finance"));
check("the app keeps its own section", has(appHello, "The Bluvfi Android app") && appHello.length < appFull.length * 0.75);

// A section is whole or absent: every kept heading's body is identical to the full prompt's.
{
  const f = full.split(String.fromCharCode(10));
  const t = webHello.split(String.fromCharCode(10));
  const sectionOf = (lines, title) => {
    const i = lines.findIndex((l) => l === title);
    if (i < 0) return null;
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith("## ")) j++;
    return lines.slice(i, j).join("|");
  };
  const bad = headings(webHello).filter((h) => h !== "## User context" && sectionOf(f, h) !== sectionOf(t, h));
  check("kept sections are byte-for-byte the same as in the full prompt", bad.length === 0, bad.join(", "));
}

const msgs = [
  { id: "1", role: "user", parts: [{ type: "text", text: "pay with xrp please" }] },
  { id: "2", role: "assistant", parts: [{ type: "tool-buy_bitrefill_product", state: "output-available" }, { type: "text", text: "Done." }] },
  { id: "3", role: "user", parts: [{ type: "text", text: "yes confirm" }] },
];
const topicText = conversationTopics(msgs, "earlier we talked about gold");
check("conversationTopics reads message text, tool names and the recap", topicText.includes("pay with xrp") && topicText.includes("buy bitrefill product") && topicText.includes("earlier we talked about gold"));
check("a follow-up like \"yes confirm\" keeps the topic via earlier messages", has(buildSystemPrompt({ topicText }), "XRP wallet & payments") && has(buildSystemPrompt({ topicText }), "Gold trading"));
check("only the latest messages count (older ones drop out)", !conversationTopics(Array.from({ length: 10 }, (_, i) => ({ id: String(i), role: "user", parts: [{ type: "text", text: i === 0 ? "nosana" : "hi" }] }))).includes("nosana"));

console.log(`  sizes: full ${full.length} chars | web "hello" ${webHello.length} (${Math.round((100 * webHello.length) / full.length)}%) | app full ${appFull.length} | app "balance" ${appHello.length} (${Math.round((100 * appHello.length) / appFull.length)}%)`);
finish();
