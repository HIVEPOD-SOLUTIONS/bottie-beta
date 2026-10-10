/**
 * The AI agent and the network: the system prompt knows about Shar and the open provider network ONLY inside the Android app,
 * and the three read-only tools answer from real data without leaking anything private. The real src/lib code on an in-memory
 * Postgres built from the real migrations.
 *
 *     node scripts/tests/ai-network.test.cjs
 */
const { makeLoader, freshDb, reporter, req } = require("./_harness.cjs");
const { check, finish } = reporter();

const WALLET = "5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM";

(async () => {
  const { client, db } = await freshDb();
  const load = makeLoader({
    "@/lib/db": { db },
    // a real encryption key, so the tests can prove a saved API key never reaches the agent
    "@/lib/server-env": { getServerEnv: (n) => ({ PROVIDER_SECRET_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff" })[n] },
    "node:dns": { promises: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } },
    ai: { tool: (definition) => definition },
    zod: req("zod"),
  });
  const prompt = load("src/lib/ai/system-prompt.ts");
  const net = load("src/lib/provider-network.ts");
  const credits = load("src/lib/credits.ts");
  const { createNetworkTools } = load("src/lib/ai/network-tools.ts");
  const q = async (text, params = []) => (await client.query(text, params)).rows;

  // ── the prompt ────────────────────────────────────────────────────────────
  const app = prompt.buildSystemPrompt({ client: "expo-android", userName: "Ada" });
  const web = prompt.buildSystemPrompt({ userName: "Ada" });
  check("app prompt: explains Shar and says to call get_my_shar instead of guessing", /Shar is Bluvfi's reward unit/.test(app) && /call get_my_shar/.test(app));
  check("app prompt: gives the real claim rules (1,000 Shar, 0.9 SKR, team reviews)", /1,000 Shar/.test(app) && /0\.9 SKR/.test(app) && /team reviews and sends every claim/.test(app));
  check("app prompt: explains the network, credits, 80% commission and owner controls", /open provider network/.test(app) && /prepaid credits/.test(app) && /80%/.test(app) && /edit, pause or remove/.test(app) && /features standout providers/.test(app));
  check("app prompt: names the tools to use", /search_network_providers/.test(app) && /get_my_network_account/.test(app));
  check("app prompt: says the agent cannot claim, withdraw, add credits or change a listing", /cannot claim Shar, withdraw commission, add credits, call a provider or change a listing/.test(app));
  check("app prompt: allows the new screen links and provider links, still forbids inventing others", /\[Shar\]\(bluvfi:\/\/shar\)/.test(app) && /\[Open network\]\(bluvfi:\/\/network\)/.test(app) && /bluvfi:\/\/provider\/<id>/.test(app) && /never invent other bluvfi:\/\/ links/.test(app));
  check("app prompt: knows the FAQ and Activity pages and may link to them", app.includes("[FAQ](bluvfi://faq)") && app.includes("[Activity](bluvfi://activity)") && app.includes("Help & FAQ page"));
  check("app prompt: explains converting claimed SKR to USDC (manually or automatically), that it is the user's own wallet, and that the agent can't do it", app.includes("Convert to USDC") && app.includes("Use my SKR when I'm short on USDC") && app.includes("You cannot convert or move SKR for them"));
  check("app prompt: says becoming a creator is opt-in, links the sign-up, and that the agent can't sign anyone up", app.includes("optional, free sign-up") && app.includes("[Become a creator](bluvfi://creator)") && app.includes("opt-in sign-up") && app.includes("You can't sign anyone up or agree to terms for them"));
  {
    const nr = load("src/lib/provider-network-rules.ts").NETWORK;
    const sr = load("src/lib/shar-rules.ts");
    const n = (x) => x.toLocaleString("en-US");
    check("app prompt: every number it quotes matches the real rules (ranks, claim minimum, purchase minimum, provider caps, price cap)", sr.TIERS.every((t) => app.includes(`${t.name} from ${n(t.from)}`)) && app.includes(`${n(sr.SHAR.minClaimShar)} Shar or more`) && app.includes(`purchases under $${sr.SHAR.minPurchaseUsd} earn none`) && app.includes(`first ${nr.earningUsesPerCallerPerDay} uses a day`) && app.includes(`at most ${nr.ownerDailyShar} Shar a day`) && app.includes(`at most $${nr.maxPriceUsdc}`) && app.includes(`${sr.SHAR.perUsd} Shar per $1`) && app.includes(`1 Shar = ${sr.SHAR.skrPerShar} SKR`));
  }
  check("app prompt: explains fairness limits and linked accounts without helping to get around them, claiming, adding credits, withdrawing, x402, and keeps admin and other people's data private", app.includes("Never help anyone get around these limits") && app.includes("linked") && app.includes("Claiming Shar:") && app.includes("Adding credits") && app.includes("Withdrawing commission") && app.includes("x402") && app.includes("Never discuss or point anyone to them"));
  check("app prompt: explains the full-screen provider form, its sections, the encrypted key, and never to ask for a key in chat", ["What people send", "Before it can be used", "Connect your API", "Notes for the Bluvfi team", "Copy setup from another provider", "stored encrypted", "Never ask for or repeat an API key in chat"].every((x) => app.includes(x)));
  check("app prompt: explains the team's question and declined reasons, and how to use the new tools", app.includes("The team asked") && app.includes("teamQuestion") && app.includes("declinedBecause") && app.includes("get_provider_details") && app.includes("get_my_activity") && app.includes("stepsBeforeUse"));
  check("app prompt: explains owners' own terms: on top of Bluvfi's, agree before use, recorded per version, agents send a header, never agree for someone", app.includes("Your terms for people who use it") && app.includes("on top of Bluvfi's Terms of Service") && app.includes("exact version") && app.includes("X-Bluvfi-Terms") && app.includes("youHaveAgreed") && app.includes("Never agree to terms on anyone's behalf"));
  check("web prompt: mentions none of it (unchanged for the website)", !/Shar/.test(web) && !/get_my_shar/.test(web) && !/open provider network/i.test(web) && !/bluvfi:\/\/shar/.test(web));

  // ── the tools are actually registered, and only for the mobile app ────────
  const fsx = require("fs");
  const pathx = require("path");
  const toolsSrc = fsx.readFileSync(pathx.join(__dirname, "../../src/lib/ai/tools.ts"), "utf8");
  const chatSrc = fsx.readFileSync(pathx.join(__dirname, "../../src/app/api/chat/route.ts"), "utf8");
  check("tools: the Shar / network tools are registered in the chat's tool set (not just imported)", /\.\.\.\(client === "expo-android" \? createNetworkTools\(userId\) : \{\}\)/.test(toolsSrc));
  check("tools: ...and ONLY for the mobile app: the website chat gets none of them", /client === "expo-android" \? createNetworkTools/.test(toolsSrc) && !/^\s*\.\.\.createNetworkTools\(/m.test(toolsSrc));
  check("tools: the chat route tells createTools which client is calling", /userName, typeof client === "string" \? client : undefined\)/.test(chatSrc));

  // ── the tools ─────────────────────────────────────────────────────────────
  const tools = createNetworkTools("ADA");
  check("tools: the five tools exist, all read-only by name (nothing that claims, pays, edits or converts)", Object.keys(tools).sort().join() === "get_my_activity,get_my_network_account,get_my_shar,get_provider_details,search_network_providers");
  const anon = createNetworkTools(undefined);
  check("tools: signed-out callers get an error, not data", (await anon.get_my_shar.execute({})).error === "Not signed in." && (await anon.search_network_providers.execute({})).error === "Not signed in." && (await anon.get_my_network_account.execute({})).error === "Not signed in.");

  await q(`insert into payments (user_id, type, status, amount_usdc, description) values ('ADA', 'bill', 'completed', '1500', 'Steam gift card')`);
  const shar0 = await tools.get_my_shar.execute({});
  check("get_my_shar: the real numbers (1,500 available, can claim, worth 1,350 SKR)", shar0.sharAvailable === 1500 && shar0.canClaimNow === true && shar0.worthSkrIfClaimedNow === "1350" && shar0.skrPerShar === 0.9 && shar0.minimumClaimShar === 1000, JSON.stringify(shar0).slice(0, 160));
  check("get_my_shar: gives the rank and a shareable referral link", shar0.rank?.name && /^https:\/\/www\.bluvfi\.xyz\/r\/[A-Z0-9]{8}$/.test(shar0.referral?.link ?? "") && shar0.referral.code.length === 8);
  const claim = await load("src/lib/shar.ts").createClaim("ADA", { shar: 1000, wallet: WALLET });
  const shar1 = await tools.get_my_shar.execute({});
  check("get_my_shar: after claiming it shows the claim in progress and can't claim again", claim.ok && shar1.canClaimNow === false && shar1.claimInProgress?.shar === 1000 && /review/.test(shar1.claimInProgress.status) && shar1.sharAvailable === 500, JSON.stringify(shar1.claimInProgress));

  const mk = async (owner, name, o = {}) => {
    const r = await net.createListing(owner, { name, summary: "Does something useful for testing the agent.", category: "data", endpointUrl: "https://api.example.com/secret-path", priceUsdc: "0", payoutWallet: WALLET, ...o });
    if (!r.ok) throw new Error(r.error);
    await net.reviewListing(r.listing.id, "verify", null);
    return r.listing;
  };
  const weather = await mk("BOB", "Weather Wisp", { summary: "Hyperlocal weather forecasts for West Africa." });
  const oracle = await mk("BOB", "Price Oracle", { category: "defi", priceUsdc: "0.05", summary: "Signed spot prices for 500 tokens, billed per call." });
  await net.reviewListing(oracle.id, "feature", null);
  const found = await tools.search_network_providers.execute({ query: "weather" });
  check("search: finds by words and links to the provider", found.count === 1 && found.providers[0].name === "Weather Wisp" && found.providers[0].link === `bluvfi://provider/${weather.id}` && found.providers[0].pricePerCallUsdc === "free");
  const all = await tools.search_network_providers.execute({});
  check("search: featured first, with the flag and price", all.providers[0].name === "Price Oracle" && all.providers[0].featured === true && all.providers[0].pricePerCallUsdc === "0.05");
  const freeOnly = await tools.search_network_providers.execute({ freeOnly: true });
  check("search: free only and category filters work", freeOnly.providers.every((p) => p.pricePerCallUsdc === "free") && (await tools.search_network_providers.execute({ category: "defi" })).providers.length === 1);
  check("search: never leaks the endpoint URL or the payout wallet", !JSON.stringify(all).includes("secret-path") && !JSON.stringify(all).includes(WALLET));
  check("search: limit is respected", (await tools.search_network_providers.execute({ limit: 1 })).providers.length === 1);

  const bob = createNetworkTools("BOB");
  await credits.creditTopup("BOB", "sig-bob", 2_000_000);
  await q(`insert into earnings_balances (user_id, available_micro, lifetime_micro) values ('BOB', 6200000, 9000000) on conflict (user_id) do update set available_micro = 6200000, lifetime_micro = 9000000`);
  await mk("BOB", "Pending Wisp"); // verified too; add one still in review
  const pending = await net.createListing("BOB", { name: "In Review Wisp", summary: "Waiting for the team to look at it.", category: "ai", endpointUrl: "https://api.example.com/x", priceUsdc: "0", payoutWallet: WALLET });
  const acct = await bob.get_my_network_account.execute({});
  check("account: credits, commission and withdraw state", acct.creditsUsd === "2" && acct.commission.availableUsd === "6.2" && acct.commission.earnedAllTimeUsd === "9" && acct.commission.canWithdrawNow === true && acct.commission.minimumWithdrawUsd === "5", JSON.stringify(acct.commission));
  check("account: lists their providers with plain-language status and links", acct.providers.some((p) => p.name === "Weather Wisp" && p.status === "live") && acct.providers.some((p) => p.name === "In Review Wisp" && p.status === "in review") && acct.providers.every((p) => p.link.startsWith("bluvfi://provider/")));
  check("account: never leaks endpoint URLs or wallets", !JSON.stringify(acct).includes("secret-path") && !JSON.stringify(acct).includes(WALLET) && pending.ok);
  await net.ownerAction("BOB", weather.id, "delete");
  check("account: a removed provider disappears from the list", !(await bob.get_my_network_account.execute({})).providers.some((p) => p.name === "Weather Wisp"));

  // ── creator status: opt-in, and the agent never sees the contact email ──
  check("account: someone who hasn't signed up as a creator is told how to (not that they are one)", acct.creator.signedUp === false && acct.creator.becomeOne === "bluvfi://creator");
  const V = load("src/lib/provider-publisher-rules.ts").PROVIDER_TERMS_VERSION;
  await net.enrollCreator("BOB", { operatorType: "company", companyName: "Bob Labs", contactEmail: "bob-private@example.com", termsAccepted: true, termsVersion: V });
  const acct2 = await bob.get_my_network_account.execute({});
  check("account: a signed-up creator shows as one, listing as their company, with nothing to re-agree", acct2.creator.signedUp === true && acct2.creator.listingAs === "Bob Labs" && acct2.creator.mustAgreeToNewTerms === false);
  await q(`update provider_creators set terms_version = '2020-01-01' where user_id = 'BOB'`);
  check("account: when the provider terms changed, it says they must agree again", (await bob.get_my_network_account.execute({})).creator.mustAgreeToNewTerms === true);
  check("account: the contact email never reaches the agent", !JSON.stringify(acct2).includes("bob-private@example.com"));

  // ── providers with setup: what the agent can say, and what it must never see ──
  const SECRET = "sk_agent_SUPERSECRET_123";
  const publisher = (o = {}) => ({ operatorType: "company", companyName: "Acme Labs", contactEmail: "private-owner@example.com", rightsConfirmed: true, termsAccepted: true, termsVersion: load("src/lib/provider-publisher-rules.ts").PROVIDER_TERMS_VERSION, ...o });
  const setupBody = (name, o = {}) => ({
    name, summary: "A provider that needs some setup first.", category: "data", endpointUrl: "https://api.example.com/secret-path", priceUsdc: "0", payoutWallet: WALLET, ...publisher(),
    inputFields: [{ key: "city", label: "City", type: "text", required: true, help: "Which city", placeholder: "Lagos", choices: null, default: null }, { key: "units", label: "Units", type: "choice", required: false, help: null, placeholder: null, choices: ["metric", "imperial"], default: "metric" }],
    requirements: ["Create a free account at acme.example.com", "Copy your region code"],
    setupUrl: "https://acme.example.com/signup",
    teamNotes: "PRIVATE-NOTE allowlist 203.0.113.7",
    auth: { type: "header", header: "X-API-Key", secret: SECRET },
    ...o,
  });
  const enrolledOwners = new Set();
  const sub = async (owner, name, o) => {
    if (!enrolledOwners.has(owner)) {
      const e = await net.enrollCreator(owner, { operatorType: "individual", contactEmail: "private-owner@example.com", termsAccepted: true, termsVersion: load("src/lib/provider-publisher-rules.ts").PROVIDER_TERMS_VERSION });
      if (!e.ok) throw new Error(e.error);
      enrolledOwners.add(owner);
    }
    const r = await net.submitListing(owner, setupBody(name, o));
    if (!r.ok) throw new Error(r.error);
    return r.listing;
  };
  const setupWisp = await sub("CARL", "Setup Wisp");
  await net.reviewListing(setupWisp.id, "verify", null);
  const leaks = (value) => ["secret-path", WALLET, SECRET, "SUPERSECRET", "PRIVATE-NOTE", "private-owner@example.com", "203.0.113.7", "v1."].filter((x) => JSON.stringify(value).includes(x));

  const sFound = await tools.search_network_providers.execute({ query: "setup" });
  const sw = sFound.providers.find((p) => p.name === "Setup Wisp");
  check("search: says which providers need setup first and what they ask for", sw && sw.needsSetupFirst === true && sw.asksFor.join() === "City,Units" && all.providers.every((p) => p.needsSetupFirst === false));
  check("search: never leaks the key, notes, email, endpoint or wallet", leaks(sFound).length === 0, leaks(sFound).join());

  const det = await tools.get_provider_details.execute({ id: setupWisp.id });
  check("details: the inputs with names, types, which are required, help, options and starting values", det.inputs.length === 2 && det.inputs[0].name === "city" && det.inputs[0].required === true && det.inputs[0].help === "Which city" && det.inputs[1].type === "choice" && det.inputs[1].options.join() === "metric,imperial" && det.inputs[1].startingValue === "metric", JSON.stringify(det.inputs));
  check("details: the steps before use and the setup link, so the agent can say it isn't usable right away", det.stepsBeforeUse.length === 2 && det.setupLink === "https://acme.example.com/signup" && det.canUseRightAway === false && det.state === "live");
  check("details: a provider with no steps that is live can be used right away", (await tools.get_provider_details.execute({ id: oracle.id })).canUseRightAway === true && (await tools.get_provider_details.execute({ id: oracle.id })).inputs.length === 0);
  check("details: gives the link, price and owner handle", det.link === `bluvfi://provider/${setupWisp.id}` && det.pricePerCallUsdc === "free" && typeof det.owner === "string" && det.yours === false);
  check("details: never leaks the key, notes, email, endpoint or wallet", leaks(det).length === 0, leaks(det).join());
  check("details: a bad id or a missing provider is a clear message, not a crash", (await tools.get_provider_details.execute({ id: "nope" })).error.includes("isn't a provider id") && (await tools.get_provider_details.execute({ id: "00000000-0000-0000-0000-000000000000" })).error.includes("wasn't found"));
  const hidden = await sub("CARL", "Hidden Wisp");
  check("details: someone else's provider that isn't live yet can't be seen by the agent", (await tools.get_provider_details.execute({ id: hidden.id })).error.includes("wasn't found"));
  const carl = createNetworkTools("CARL");
  const own = await carl.get_provider_details.execute({ id: hidden.id });
  check("details: but its owner can ask about it (in review) and still sees no key or private notes", own.yours === true && /in review/.test(own.state) && leaks(own).length === 0, leaks(own).join());
  check("details: signed out is an error", (await anon.get_provider_details.execute({ id: setupWisp.id })).error === "Not signed in.");

  // the owner's own terms
  const TERMS_TEXT = "You may use this for lawful purposes only. Do not resell the data.";
  const termed = await sub("CARL", "Termed Wisp", { requirements: [], inputFields: [], setupUrl: null, auth: undefined, customTerms: { text: TERMS_TEXT, url: "https://acme.example.com/terms" } });
  await net.reviewListing(termed.id, "verify", null);
  const td = await tools.get_provider_details.execute({ id: termed.id });
  check("details: the owner's own terms, and that this user hasn't agreed yet, so it isn't usable right away", td.ownerTerms && td.ownerTerms.text === TERMS_TEXT && td.ownerTerms.link === "https://acme.example.com/terms" && td.ownerTerms.youHaveAgreed === false && td.canUseRightAway === false);
  const termsHash = load("src/lib/provider-terms-rules.ts").termsHash({ text: TERMS_TEXT, url: "https://acme.example.com/terms" });
  await net.acceptTerms("ADA", termed.id, termsHash);
  const td2 = await tools.get_provider_details.execute({ id: termed.id });
  check("details: after the user agrees on the provider's page it says so and the provider is usable", td2.ownerTerms.youHaveAgreed === true && td2.canUseRightAway === true);
  check("details: for the owner it isn't needed", (await carl.get_provider_details.execute({ id: termed.id })).ownerTerms.youHaveAgreed === "not needed: it is yours");
  check("details: a provider without terms has none", td.ownerTerms !== null && (await tools.get_provider_details.execute({ id: oracle.id })).ownerTerms === null);
  check("search: flags the providers that have their own terms", (await tools.search_network_providers.execute({ query: "termed" })).providers[0].hasOwnerTerms === true && all.providers.every((p) => p.hasOwnerTerms === false));
  check("account: the owner's list says which of their providers have their own terms", (await carl.get_my_network_account.execute({})).providers.find((p) => p.name === "Termed Wisp").hasOwnTerms === true);
  check("terms: the agent can't agree on anyone's behalf (no tool does)", !Object.keys(tools).some((n) => /accept|agree/i.test(n)));

  // the team asks a question; another listing gets declined
  await net.reviewListing(hidden.id, "request_info", "Which regions do you serve?");
  const declined = await sub("CARL", "Declined Wisp");
  await net.reviewListing(declined.id, "reject", "The endpoint returned an error when we tested it.");
  const cacct = await carl.get_my_network_account.execute({});
  const byName = (n) => cacct.providers.find((p) => p.name === n);
  check("account: shows the team's question on a listing in review", byName("Hidden Wisp").teamQuestion === "Which regions do you serve?" && byName("Hidden Wisp").status === "in review" && byName("Setup Wisp").teamQuestion === null);
  check("account: shows why a listing was declined", byName("Declined Wisp").declinedBecause === "The endpoint returned an error when we tested it." && byName("Hidden Wisp").declinedBecause === null);
  check("account: summarises the setup, and whether a key is saved, without the key", byName("Setup Wisp").setup.requestInputs === 2 && byName("Setup Wisp").setup.stepsBeforeUse === 2 && byName("Setup Wisp").setup.connection === "API-key header" && byName("Setup Wisp").setup.keySaved === true);
  check("account: never leaks the key, notes, email, endpoint or wallet", leaks(cacct).length === 0, leaks(cacct).join());
  await net.ownerAction("CARL", declined.id, "pause").catch(() => {});

  // ── activity ────────────────────────────────────────────────────────────────
  const act = await tools.get_my_activity.execute({});
  check("activity: the user's own history, newest first, in words (a purchase and a claim in review)", act.entries.length >= 2 && act.entries.some((e) => e.amount === "+1,500 Shar" && e.state === "done") && act.entries.some((e) => e.amount === "-1,000 Shar" && e.state === "in review"), JSON.stringify(act.entries).slice(0, 220));
  check("activity: a person who is NOT a creator (ADA) is not sent to the creator-only Activity screen, and is told how to unlock it", act.openTheScreen === null && /creators only/.test(act.screenNote) && /Become a creator/.test(act.screenNote) && /don't link/.test(act.screenNote));
  check("activity: a creator (BOB) is pointed to the Activity screen", (await bob.get_my_activity.execute({})).openTheScreen === "bluvfi://activity" && (await bob.get_my_activity.execute({})).screenNote === undefined);
  check("shar: a non-creator gets the numbers and no link to the Shar screen", (await tools.get_my_shar.execute({})).howItWorks.openTheScreen === null && /creators only/.test((await tools.get_my_shar.execute({})).howItWorks.screenNote));
  check("app prompt: the Shar, Activity and FAQ screens are creator-only, check signedUp before linking, otherwise answer in chat", app.includes("only for provider creators") && app.includes("check creator.signedUp in get_my_network_account") && app.includes("do NOT link") && app.includes("Shar, FAQ and Activity links only for creators"));
  {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../../src/lib/ai/tools.ts"), "utf8");
    check("bitrefill poll: takes the invoice's access token and passes it to Bitrefill (an invoice can be 'not found' without it)", /accessToken: z\s*\.string\(\)/.test(src) && src.includes("mcpGetInvoice(invoiceId, accessToken)"));
    check("bitrefill poll: 'Invoice not found' comes back as pending (not an error card), with instructions to stop after a few tries and not blame Bitrefill or ask for a second payment", src.includes("/not found|RESOURCE_NOT_FOUND/i.test(message)") && src.includes('status: "pending"') && src.includes("Do not say Bitrefill is slow") && src.includes("do not ask them to pay again"));
    check("bitrefill buy: tells the agent to pass the access token when it polls", src.includes("const tokenArg = invoice.invoice_access_token") && src.includes('poll_bitrefill_order(invoiceId="${invoice.invoice_id}"${tokenArg}'));
  }
  check("app prompt: explains the weekly leaderboard (top 10, anonymous handles, never identify anyone) and answers non-creators from get_my_shar", app.includes("top 10 by anonymous handle") && app.includes("never shows names, emails or wallets") && app.includes("never try to identify anyone") && app.includes("weeklyTrial"));
  check("app prompt: knows the Profile row Become a creator, the country picker and purchase details", app.includes("Profile, Become a creator") && app.includes("country picker") && app.includes("redemption code") && app.includes("Copy code"));
  check("activity: filters and limits", (await tools.get_my_activity.execute({ source: "shar" })).entries.every((e) => /Shar$/.test(e.amount)) && (await tools.get_my_activity.execute({ limit: 1 })).entries.length === 1 && (await tools.get_my_activity.execute({ limit: 1 })).hasMore === true);
  const bobAct = await bob.get_my_activity.execute({ source: "credits" });
  check("activity: credits show as dollars with a dollar sign, and only the user's own entries", bobAct.entries.some((e) => e.amount === "+$2" || e.amount === "+$2.00") && bobAct.entries.every((e) => e.amount.includes("$")), JSON.stringify(bobAct.entries).slice(0, 200));
  check("activity: nobody else's entries (ADA's claim never shows for BOB)", !JSON.stringify(await bob.get_my_activity.execute({})).includes("1,000 Shar"));
  check("activity: signed out is an error", (await anon.get_my_activity.execute({})).error === "Not signed in.");

  // ── weekly trial in get_my_shar ─────────────────────────────────────────────
  const sharNow = await tools.get_my_shar.execute({});
  check("get_my_shar: includes the weekly trial rank and when it resets", sharNow.weeklyTrial && Number.isInteger(sharNow.weeklyTrial.yourRank) && typeof sharNow.weeklyTrial.resetsAt === "string");

  // when the new tables aren't there yet, say so plainly instead of failing
  await client.exec(`drop table credit_balances cascade; drop table earnings_balances cascade;`);
  const broken = await bob.get_my_network_account.execute({});
  check("tools: missing tables -> a safe 'coming soon' message, not a crash", typeof broken.error === "string" && /switched on yet/.test(broken.error), JSON.stringify(broken).slice(0, 100));

  finish();
})().catch((e) => {
  process.stderr.write(`AI-NETWORK TEST CRASHED ${(e && e.stack) || e}\n`);
  process.exit(2);
});
