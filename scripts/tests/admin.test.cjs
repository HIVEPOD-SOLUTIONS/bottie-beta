/**
 * Admin and money routes, called the way Next calls them: authorisation (signed out / not an admin / admin), the review queue,
 * paying, rejecting and reconciling payouts, the audit trail, and the user-facing credits / earnings / withdrawal routes.
 * The real route handlers and libraries on an in-memory Postgres, with a simulated chain.
 *
 *     node scripts/tests/admin.test.cjs
 */
const { makeLoader, freshDb, reporter } = require("./_harness.cjs");
const { fakeChain, decode } = require("./_fakechain.cjs");
const { check, finish } = reporter();

const ADMIN = "did:privy:admin1";
const USER = "did:privy:user1";
const WALLET = "5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM";
const UUID0 = "00000000-0000-0000-0000-000000000000";

class Res { constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.headers = init.headers ?? {}; } static json(d, i) { return new Res(JSON.stringify(d), i); } }
const auth = { user: ADMIN, ok: true };
const env = { NETWORK_ADMIN_USER_IDS: ADMIN, CREDITS_DEPOSIT_ADDRESS: "DepositAddr1111111111111111111111111111111" };

(async () => {
  const { client, db } = await freshDb();
  const chain = fakeChain();
  const base = {
    "next/server": { NextResponse: Res, NextRequest: class {} },
    "@/lib/auth": { verifyAuth: async () => { if (!auth.ok) throw new Error("nope"); return { userId: auth.user }; }, getUserWalletAddresses: async () => ({ evm: [], solana: [] }) },
    "@/lib/auth-response": { authErrorResponse: () => Res.json({ error: "Unauthorized" }, { status: 401 }) },
    "@/lib/user-rate-limiter": { checkApiLimit: async () => ({ allowed: true, headers: {} }) },
    "@/lib/server-env": { getServerEnv: (n) => env[n] },
    "node:dns": { promises: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } },
    "@/lib/db": { db },
  };
  // The routes get the simulated chain instead of a real one.
  const realPayout = makeLoader(base)("src/lib/skr-payout.ts");
  const payoutWithChain = {
    ...realPayout,
    getRealChain: async () => chain,
    payPayout: (i) => realPayout.payPayout(i, chain),
    quotePayout: (k, id) => realPayout.quotePayout(k, id, chain),
    reconcilePayout: (k, id) => realPayout.reconcilePayout(k, id, chain),
  };
  const load = makeLoader({ ...base, "@/lib/skr-payout": payoutWithChain });
  const route = (file) => load(`src/app/api/${file}/route.ts`);

  const R = {
    me: route("admin/me"),
    queue: route("admin/queue"),
    payout: route("admin/payouts/[kind]/[id]"),
    review: route("network/providers/[id]/review"),
    credits: route("credits"),
    earnings: route("earnings"),
    withdraw: route("earnings/withdraw"),
    topup: route("credits/topup"),
  };
  const shar = load("src/lib/shar.ts");
  const net = load("src/lib/provider-network.ts");
  const earningsLib = load("src/lib/earnings.ts");

  const call = async (handler, method, { user = ADMIN, body, ctx } = {}) => {
    auth.user = user;
    const r = await handler[method]({ json: async () => (typeof body === "string" ? JSON.parse(body) : body), text: async () => JSON.stringify(body ?? {}) }, ctx);
    return { status: r.status, body: JSON.parse(r.body) };
  };
  const ctx = (kind, id) => ({ params: Promise.resolve({ kind, id }) });
  const q = async (text, params = []) => (await client.query(text, params)).rows;

  // ── authorisation
  auth.ok = false;
  check("signed out: /me, /queue, payout GET/POST and review are all 401", (await Promise.all([call(R.me, "GET"), call(R.queue, "GET"), call(R.payout, "GET", { ctx: ctx("shar_claim", UUID0) }), call(R.payout, "POST", { body: { action: "pay", acknowledgeRisk: true }, ctx: ctx("shar_claim", UUID0) }), call(R.credits, "GET"), call(R.earnings, "GET"), call(R.withdraw, "POST", { body: {} }), call(R.topup, "POST", { body: {} })])).every((r) => r.status === 401));
  auth.ok = true;

  const me = await call(R.me, "GET", { user: USER });
  check("a normal user asking /me gets a plain admin:false (200), not a 403 that reveals anything", me.status === 200 && me.body.admin === false);
  check("an admin gets admin:true", (await call(R.me, "GET")).body.admin === true);
  const denied = await Promise.all([
    call(R.queue, "GET", { user: USER }),
    call(R.payout, "GET", { user: USER, ctx: ctx("shar_claim", UUID0) }),
    call(R.payout, "POST", { user: USER, body: { action: "pay", acknowledgeRisk: true, expectedSkrMicro: 1 }, ctx: ctx("shar_claim", UUID0) }),
    call(R.payout, "POST", { user: USER, body: { action: "reject" }, ctx: ctx("commission", UUID0) }),
    call(R.review, "POST", { user: USER, body: { action: "verify" }, ctx: { params: Promise.resolve({ id: UUID0 }) } }),
  ]);
  check("a non-admin is refused (403) on the queue, quote, pay, reject and listing review", denied.every((r) => r.status === 403), denied.map((r) => r.status).join(","));
  check("a refused non-admin leaves no payout trace in the audit trail", Number((await q(`select count(*) n from admin_audit`))[0].n) === 0);

  // ── seed a realistic queue
  await q(`insert into payments (user_id, type, status, amount_usdc, description) values ($1, 'bill', 'completed', '3000', 'Gift card')`, [USER]);
  const claim = await shar.createClaim(USER, { shar: 1000, wallet: WALLET });
  await q(`insert into earnings_balances (user_id, available_micro, lifetime_micro) values ('did:privy:owner1', 9000000, 9000000)`);
  const wd = await earningsLib.requestWithdrawal("did:privy:owner1", WALLET);
  const listing = await net.createListing("did:privy:owner1", { name: "Queue Wisp", summary: "A provider waiting for review.", category: "data", endpointUrl: "https://api.example.com/v1", priceUsdc: "0.05", payoutWallet: WALLET });
  check("seeded: a claim, a withdrawal and a listing waiting", claim.ok && wd.ok && listing.ok);

  const queue = await call(R.queue, "GET");
  check("the queue lists the listing awaiting review with what an admin needs to judge it", queue.status === 200 && queue.body.listings.length === 1 && queue.body.listings[0].endpointUrl === "https://api.example.com/v1" && queue.body.listings[0].payoutWallet === WALLET && queue.body.listings[0].priceUsdc === "0.05");
  check("it lists both payouts waiting, with SKR for the claim and USD for the withdrawal", queue.body.payouts.waiting.length === 2 && queue.body.payouts.waiting.some((p) => p.kind === "shar_claim" && p.skr === "900" && p.shar === 1000) && queue.body.payouts.waiting.some((p) => p.kind === "commission" && p.usd === "9" && p.skr === null));
  check("it shows the treasury's SKR and SOL, and the payout limits", queue.body.treasury.configured === true && queue.body.treasury.skr === "1000000" && queue.body.limits.maxPayoutSkr === 25000 && queue.body.limits.dailyCapSkr === 100000);
  check("it carries recent audit entries", Array.isArray(queue.body.audit));

  // ── verify the listing through the review route: audited
  const verified = await call(R.review, "POST", { body: { action: "verify", note: "checked the endpoint" }, ctx: { params: Promise.resolve({ id: listing.listing.id }) } });
  check("an admin can verify a listing", verified.status === 200 && verified.body.status === "verified");
  const aud1 = await q(`select * from admin_audit where target_type = 'listing' and target_id = $1`, [listing.listing.id]);
  check("verifying was recorded: who, what, and the note", aud1.length === 1 && aud1[0].admin_user_id === ADMIN && aud1[0].action === "listing.verify" && aud1[0].detail === "checked the endpoint");

  // ── input handling
  check("a bad payout kind is 404", (await call(R.payout, "GET", { ctx: ctx("nonsense", UUID0) })).status === 404);
  check("a bad payout id is 404", (await call(R.payout, "POST", { body: { action: "pay", acknowledgeRisk: true }, ctx: ctx("shar_claim", "not-a-uuid") })).status === 404);
  check("an unknown action is 400", (await call(R.payout, "POST", { body: { action: "refund-everything" }, ctx: ctx("shar_claim", claim.claim.id) })).status === 400);
  check("a payout that doesn't exist: pay says 404", (await call(R.payout, "POST", { body: { action: "pay", acknowledgeRisk: true }, ctx: ctx("shar_claim", UUID0) })).status === 404);

  // ── commission: review the price, then pay
  const quote = await call(R.payout, "GET", { ctx: ctx("commission", wd.payout.id) });
  check("an admin can see what paying a withdrawal would send, priced now", quote.status === 200 && quote.body.quote.usdPerSkr === "0.0176" && quote.body.quote.skrMicro === Math.round(9_000_000 / 0.0176) && quote.body.quote.wallet === WALLET);
  const noReview = await call(R.payout, "POST", { body: { action: "pay", acknowledgeRisk: true }, ctx: ctx("commission", wd.payout.id) });
  check("paying commission without the reviewed amount is refused (400, quote_required)", noReview.status === 400 && noReview.body.code === "quote_required" && chain.state.sent.length === 0);
  chain.state.quote = (usd) => ({ skrMicro: Math.round(usd / 0.012), priceImpactPct: 0.01 }); // the price moved a lot
  const drift = await call(R.payout, "POST", { body: { action: "pay", acknowledgeRisk: true, expectedSkrMicro: quote.body.quote.skrMicro }, ctx: ctx("commission", wd.payout.id) });
  check("if the price moved since the review, the click is refused (409) and shows the new amount", drift.status === 409 && drift.body.code === "price_moved" && drift.body.quote.skrMicro > 0 && chain.state.sent.length === 0);
  chain.state.quote = (usd) => ({ skrMicro: Math.round(usd / 0.0176), priceImpactPct: 0.01 });
  const paidWd = await call(R.payout, "POST", { body: { action: "pay", acknowledgeRisk: true, expectedSkrMicro: quote.body.quote.skrMicro }, ctx: ctx("commission", wd.payout.id) });
  check("with the reviewed amount, the click pays", paidWd.status === 200 && paidWd.body.status === "paid" && typeof paidWd.body.signature === "string", JSON.stringify(paidWd.body).slice(0, 90));
  const d = decode(chain.state.sent[0], chain.treasury.publicKey);
  check("the SKR sent is exactly the amount shown to the admin", d.amount === BigInt(quote.body.quote.skrMicro) && d.signature === paidWd.body.signature);

  // ── Shar claim: pay, then everything about the audit trail
  const paidClaim = await call(R.payout, "POST", { body: { action: "pay", acknowledgeRisk: true }, ctx: ctx("shar_claim", claim.claim.id) });
  check("a Shar claim is paid with one click (900 SKR)", paidClaim.status === 200 && paidClaim.body.skrMicro === 900_000_000 && chain.state.sent.length === 2);
  const twice = await call(R.payout, "POST", { body: { action: "pay", acknowledgeRisk: true }, ctx: ctx("shar_claim", claim.claim.id) });
  check("clicking Pay again on a paid payout is refused (409) and sends nothing", twice.status === 409 && chain.state.sent.length === 2);
  const audit = await q(`select action, admin_user_id, target_type, target_id, detail from admin_audit where target_type in ('shar_claim', 'commission') order by created_at, id`);
  const actions = audit.map((a) => a.action);
  check("every pay attempt was recorded: start, refusals and results, each with the admin's id", audit.length >= 6 && audit.every((a) => a.admin_user_id === ADMIN), actions.join(" | "));
  check("the audit trail has the refusals as well as the successes", actions.includes("payout.pay.refused.quote_required") && actions.includes("payout.pay.refused.price_moved") && actions.filter((a) => a === "payout.pay.paid").length === 2 && actions.includes("payout.pay.refused.not_payable"));
  check("a successful payment's audit entry carries the transaction signature", audit.some((a) => a.action === "payout.pay.paid" && a.detail === paidWd.body.signature));

  // ── reject + reconcile through the route
  await q(`insert into payments (user_id, type, status, amount_usdc, description) values ('did:privy:u2', 'bill', 'completed', '2000', 'x')`);
  const c2 = await shar.createClaim("did:privy:u2", { shar: 1000, wallet: WALLET });
  const rej = await call(R.payout, "POST", { body: { action: "reject", note: "wallet looks wrong" }, ctx: ctx("shar_claim", c2.claim.id) });
  check("an admin can reject a claim with a reason, and the Shar returns", rej.status === 200 && (await shar.getSummary("did:privy:u2")).available === 2000);
  check("...recorded in the audit trail with the reason", Number((await q(`select count(*) n from admin_audit where action = 'payout.reject' and detail = 'wallet looks wrong'`))[0].n) === 1);
  check("rejecting a paid payout is refused (409)", (await call(R.payout, "POST", { body: { action: "reject" }, ctx: ctx("shar_claim", claim.claim.id) })).status === 409);

  await q(`insert into payments (user_id, type, status, amount_usdc, description) values ('did:privy:u3', 'bill', 'completed', '2000', 'x')`);
  const c3 = await shar.createClaim("did:privy:u3", { shar: 1000, wallet: WALLET });
  chain.state.sendMode = "throw_after_landing";
  const uncertain = await call(R.payout, "POST", { body: { action: "pay", acknowledgeRisk: true }, ctx: ctx("shar_claim", c3.claim.id) });
  check("when the network answer is unclear, the admin is told plainly and it stays 'sent'", uncertain.status === 502 && uncertain.body.code === "send_uncertain" && (await q(`select status from shar_claims where id = $1`, [c3.claim.id]))[0].status === "sent");
  chain.state.sendMode = "ok";
  const rc = await call(R.payout, "POST", { body: { action: "reconcile" }, ctx: ctx("shar_claim", c3.claim.id) });
  check("pressing Reconcile finds it landed and marks it paid", rc.status === 200 && rc.body.outcome === "paid");
  const q2 = await call(R.queue, "GET");
  check("the queue now shows nothing waiting, and the recent payments as paid", q2.body.payouts.waiting.length === 0 && q2.body.payouts.paid.length === 3);

  // ── the audit write failing must not undo or block the action
  await q(`alter table admin_audit rename to admin_audit_x`);
  await q(`insert into payments (user_id, type, status, amount_usdc, description) values ('did:privy:u4', 'bill', 'completed', '2000', 'x')`);
  const c4 = await shar.createClaim("did:privy:u4", { shar: 1000, wallet: WALLET });
  const origErr = console.error; console.error = () => {};
  const noAudit = await call(R.payout, "POST", { body: { action: "reject", note: "x" }, ctx: ctx("shar_claim", c4.claim.id) });
  console.error = origErr;
  check("if the audit table is unavailable the action still succeeds (audit never blocks a payout)", noAudit.status === 200);
  await q(`alter table admin_audit_x rename to admin_audit`);

  // ── user-facing routes
  const credits = await call(R.credits, "GET", { user: USER });
  check("credits: a new user sees a $0 balance, the deposit address and the minimum", credits.status === 200 && credits.body.balanceMicro === 0 && credits.body.depositAddress === env.CREDITS_DEPOSIT_ADDRESS && credits.body.minTopupMicro === 1_000_000 && credits.body.enabled === true);
  const badTop = await call(R.topup, "POST", { user: USER, body: { signature: "nope" } });
  check("top-up with a junk signature is 400", badTop.status === 400);
  const earn = await call(R.earnings, "GET", { user: "did:privy:nobody" });
  check("earnings for someone with none: zeros, the $5 minimum, and the 80% share", earn.status === 200 && earn.body.availableMicro === 0 && earn.body.minWithdrawMicro === 5_000_000 && earn.body.ownerPct === 80 && earn.body.canWithdraw === false);
  const wdBad = await call(R.withdraw, "POST", { user: "did:privy:owner1", body: { wallet: "nope" } });
  check("withdraw with a bad wallet is 400", wdBad.status === 400);
  const wdNone = await call(R.withdraw, "POST", { user: "did:privy:nobody", body: { wallet: WALLET } });
  check("withdraw with nothing to withdraw is 400", wdNone.status === 400);
  await q(`insert into earnings_balances (user_id, available_micro, lifetime_micro) values ('did:privy:rich', 12000000, 12000000)`);
  const wdOk = await call(R.withdraw, "POST", { user: "did:privy:rich", body: { wallet: WALLET } });
  check("a real withdrawal request returns 201 with the amount", wdOk.status === 201 && wdOk.body.payout.usdMicro === 12_000_000);
  const earn2 = await call(R.earnings, "GET", { user: "did:privy:rich" });
  check("and the earnings screen then shows it as in progress", earn2.body.open && earn2.body.open.status === "requested" && earn2.body.availableMicro === 0 && earn2.body.canWithdraw === false);
  const wdAgain = await call(R.withdraw, "POST", { user: "did:privy:rich", body: { wallet: WALLET } });
  check("a second withdrawal while one is open is refused", wdAgain.status === 400 || wdAgain.status === 409);

  // ── linked accounts: paying needs an explicit acknowledgement, and it is audited
  const W_SHARED = "H3LiuMfFcWrnCmNN8M5E3jxYdQ4LpHLC5v1WJ6dmDfiB".slice(0, 44);
  const mkClaim = async (user) => {
    await q(`insert into payments (user_id, type, status, amount_usdc, description) values ($1, 'bill', 'completed', '2000', 'Gift card')`, [user]);
    const r = await load("src/lib/shar.ts").createClaim(user, { shar: 1000, wallet: W_SHARED });
    if (!r.ok) throw new Error(r.error);
    return r.claim.id;
  };
  const link1 = await mkClaim("LINK1");
  const link2 = await mkClaim("LINK2"); // same wallet as LINK1: they are linked
  const sentBefore = chain.state.sent.length;
  const gated = await call(R.payout, "POST", { body: { action: "pay" }, ctx: ctx("shar_claim", link2) });
  check("linked accounts: paying without acknowledgement is refused (409 risk_unacknowledged) and returns the flags", gated.status === 409 && gated.body.code === "risk_unacknowledged" && gated.body.risk.flags.includes("shared_wallet"), JSON.stringify(gated.body).slice(0, 120));
  check("linked accounts: nothing was sent and the payout is still waiting", chain.state.sent.length === sentBefore && (await q(`select status from shar_claims where id = $1`, [link2]))[0].status === "requested");
  const queueNow = await call(R.queue, "GET");
  const inQueue = queueNow.body.payouts.waiting.find((p) => p.id === link2);
  check("linked accounts: the queue shows the risk on the waiting payout", inQueue && inQueue.risk && inQueue.risk.flags.includes("shared_wallet") && inQueue.risk.linkedAccounts >= 1);
  const quoteLinked = await call(R.payout, "GET", { ctx: ctx("shar_claim", link2) });
  check("linked accounts: the quote carries the risk too", quoteLinked.status === 200 && quoteLinked.body.quote.risk.flags.includes("shared_wallet"));
  const acked = await call(R.payout, "POST", { body: { action: "pay", acknowledgeRisk: true }, ctx: ctx("shar_claim", link2) });
  check("linked accounts: with acknowledgement the admin can pay", acked.status === 200 && chain.state.sent.length === sentBefore + 1, JSON.stringify(acked.body).slice(0, 90));
  const ackAudit = (await q(`select action, detail from admin_audit where target_id = $1 order by created_at, id`, [link2])).map((a) => a.action + ":" + (a.detail ?? ""));
  check("linked accounts: the audit trail records both the refusal and exactly which flags were acknowledged", ackAudit.some((a) => a.startsWith("payout.pay.refused.risk_unacknowledged")) && ackAudit.some((a) => a.startsWith("payout.risk.acknowledged:") && a.includes("shared_wallet")), ackAudit.join(" | "));

  finish();
})().catch((e) => {
  console.error("TEST HARNESS ERROR", e);
  process.exit(1);
});
