/**
 * Adding credits: proving a USDC deposit really came from the user's own wallet. Runs on REAL mainnet USDC transfers
 * (scripts/tests/fixtures/usdc-transfers.json, public chain data) plus tampered copies of them for the attack cases.
 *
 *     node scripts/tests/topup.test.cjs
 */
const fs = require("fs");
const path = require("path");
const { makeLoader, freshDb, reporter, ROOT } = require("./_harness.cjs");
const { check, finish } = reporter();

const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/tests/fixtures/usdc-transfers.json"), "utf8"));
const USDC = fixtures.usdcMint;
const clone = (x) => JSON.parse(JSON.stringify(x));

(async () => {
  const { db } = await freshDb();
  let wallets = [];
  const load = makeLoader({
    "@/lib/db": { db },
    "@/lib/server-env": { getServerEnv: () => undefined },
    "@/lib/auth": { getUserWalletAddresses: async () => ({ evm: [], solana: wallets }) },
  });
  const topup = load("src/lib/topup.ts");
  const credits = load("src/lib/credits.ts");
  const { verifyUsdcDeposit, usdcDeltaByOwner, topupFromSignature } = topup;

  check("have real fixtures to work with", fixtures.transfers.length >= 2, `${fixtures.transfers.length} transfers`);

  for (const f of fixtures.transfers) {
    const tag = f.signature.slice(0, 8);
    const delta = usdcDeltaByOwner(f.tx, USDC);
    check(`[${tag}] balance deltas: receiver +${f.amount}, sender -${f.amount}`, delta.get(f.to) === BigInt(f.amount) && delta.get(f.from) === -BigInt(f.amount));

    const ok = verifyUsdcDeposit(f.tx, { depositOwner: f.to, userWallets: [f.from] });
    check(`[${tag}] a deposit from the user's wallet to the deposit address is credited in full`, ok.ok && ok.amountMicro === Number(f.amount), JSON.stringify(ok));
    check(`[${tag}] it names the sending wallet`, ok.ok && ok.from[0] === f.from);

    const stranger = verifyUsdcDeposit(f.tx, { depositOwner: f.to, userWallets: ["SomeoneElse1111111111111111111111111111111"] });
    check(`[${tag}] someone ELSE cannot claim this deposit (not their wallet)`, !stranger.ok && stranger.reason === "not_from_you");

    const wrongAddr = verifyUsdcDeposit(f.tx, { depositOwner: "NotTheDepositAddress11111111111111111111111", userWallets: [f.from] });
    check(`[${tag}] a transfer to some other address is not a deposit`, !wrongAddr.ok && wrongAddr.reason === "no_deposit");

    const reversed = verifyUsdcDeposit(f.tx, { depositOwner: f.from, userWallets: [f.to] });
    check(`[${tag}] the deposit address SENDING money is not a deposit`, !reversed.ok);

    const failed = clone(f.tx);
    failed.meta.err = { InstructionError: [0, "Custom"] };
    check(`[${tag}] a failed transaction credits nothing`, verifyUsdcDeposit(failed, { depositOwner: f.to, userWallets: [f.from] }).reason === "failed");

    const otherMint = clone(f.tx);
    for (const b of [...otherMint.meta.preTokenBalances, ...otherMint.meta.postTokenBalances]) b.mint = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";
    check(`[${tag}] a transfer of a different token (not USDC) credits nothing`, !verifyUsdcDeposit(otherMint, { depositOwner: f.to, userWallets: [f.from] }).ok);

    const noMeta = { meta: null };
    check(`[${tag}] a transaction with no metadata credits nothing`, verifyUsdcDeposit(noMeta, { depositOwner: f.to, userWallets: [f.from] }).reason === "failed");

    // The sender received more than the deposit sent from elsewhere: only what THEY sent counts.
    const inflated = clone(f.tx);
    for (const b of inflated.meta.postTokenBalances) if (b.owner === f.to && b.mint === USDC) b.uiTokenAmount.amount = String(BigInt(b.uiTokenAmount.amount) + 5_000_000n);
    const capped = verifyUsdcDeposit(inflated, { depositOwner: f.to, userWallets: [f.from] });
    check(`[${tag}] the credit is capped at what the user's wallet actually lost`, capped.ok && capped.amountMicro === Number(f.amount), JSON.stringify(capped));
  }

  // ── the full service, with the chain simulated by the fixtures
  const f = fixtures.transfers.find((t) => BigInt(t.amount) >= 1_000_000n) ?? fixtures.transfers[0];
  const bySig = new Map(fixtures.transfers.map((t) => [t.signature, t.tx]));
  const deps = (over = {}) => ({
    getTx: async (sig) => bySig.get(sig) ?? null,
    getWallets: async () => [f.from],
    depositAddress: () => f.to,
    now: () => (f.tx.blockTime ?? 0) * 1000 + 60_000,
    ...over,
  });

  check("not configured: 503", (await topupFromSignature("U1", f.signature, deps({ depositAddress: () => undefined }))).status === 503);
  check("garbage signature: 400", (await topupFromSignature("U1", "hello", deps())).status === 400);
  check("a transaction we can't see yet: 404 (try again)", (await topupFromSignature("U1", "5".repeat(88), deps())).status === 404);
  const leak = await topupFromSignature("U1", f.signature, deps({ getTx: async () => { throw new Error("https://x.alchemy.com/v2/SECRETKEY failed"); } }));
  check("an RPC error never leaks its URL or key to the user", leak.status === 502 && !/SECRET|alchemy/.test(leak.error), leak.error);
  check("too old (over 7 days): refused", (await topupFromSignature("U1", f.signature, deps({ now: () => (f.tx.blockTime + 8 * 86400) * 1000 }))).status === 400);

  const good = await topupFromSignature("U1", f.signature, deps());
  check("a real deposit is credited to the user who sent it", good.ok && good.credited === true && good.amountMicro === Number(f.amount) && good.balanceMicro === Number(f.amount), JSON.stringify(good));
  const again = await topupFromSignature("U1", f.signature, deps());
  check("submitting the SAME signature again credits nothing more", again.ok && again.credited === false && again.balanceMicro === Number(f.amount));
  const thief = await topupFromSignature("THIEF", f.signature, deps({ getWallets: async () => ["Some.Other.Wallet"] }));
  check("another user submitting that signature is refused", !thief.ok && thief.status === 400 && (await credits.getBalanceMicro("THIEF")) === 0);
  const sneaky = await topupFromSignature("THIEF", f.signature, deps({ getWallets: async () => [f.from] }));
  check("even claiming the same sender wallet gets nothing: the signature was already credited once", sneaky.ok && sneaky.credited === false && (await credits.getBalanceMicro("THIEF")) === 0, JSON.stringify(sneaky));

  const small = fixtures.transfers.find((t) => BigInt(t.amount) < 1_000_000n);
  if (small) {
    const dust = await topupFromSignature("U9", small.signature, deps({ depositAddress: () => small.to, getWallets: async () => [small.from], now: () => (small.tx.blockTime + 60) * 1000 }));
    check("a deposit under $1 is refused", !dust.ok && dust.status === 400);
  } else {
    console.log("NOTE  no sub-$1 fixture; the $1 minimum is covered in credits-gateway.test.cjs");
  }

  finish();
})().catch((e) => {
  console.error("TEST HARNESS ERROR", e);
  process.exit(1);
});
