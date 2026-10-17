/**
 * Paying a bill from a Circle treasury: the request sent to Circle names the token's chain (without it Circle answers "API parameter invalid"
 * and no payment ever leaves a treasury), carries the amount, destination, fee level and the idempotency key; and a run stays inside the
 * server's request limit (the model and the confirmation wait are bounded, and the route allows 60 s).
 *
 *     node scripts/tests/business-treasury.test.cjs
 */
const fs = require("fs");
const path = require("path");
const { makeLoader, reporter } = require("./_harness.cjs");
const { check, finish } = reporter();
const root = path.join(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

(async () => {
  const calls = [];
  let nextError = null;
  const fakeCircle = {
    initiateDeveloperControlledWalletsClient: () => ({
      createTransaction: async (input) => {
        calls.push(input);
        // Circle's rule for a token named by its address: the chain is required too.
        if (nextError) throw nextError;
        if (input.tokenAddress && !input.blockchain) throw new Error("API parameter invalid");
        return { data: { id: "tx_123" } };
      },
      getTransaction: async () => ({ data: { transaction: { state: "COMPLETE", txHash: "0xabc" } } }),
    }),
  };
  process.env.CIRCLE_API_KEY = "test-key";
  process.env.CIRCLE_ENTITY_SECRET = "test-secret";
  const load = makeLoader({
    "@circle-fin/developer-controlled-wallets": fakeCircle,
    viem: require(path.join(root, "node_modules/viem")),
    "viem/accounts": require(path.join(root, "node_modules/viem/accounts")),
  });
  const t = load("src/lib/business/treasury.ts");
  const row = { id: "b1", treasuryAddress: "0x" + "1".repeat(40), custody: "circle", circleWalletId: "wallet_1", encryptedKey: null };
  const key = "11111111-1111-4111-8111-111111111111";
  const to = "0x" + "2".repeat(40);

  const out = await t.sendTreasuryUsdc(row, to, 0.5, key);
  const sent = calls[0] ?? {};
  check("a Circle payment names the token's chain (ARC) next to its address, so Circle accepts it", sent.blockchain === "ARC" && /^0x3600/i.test(String(sent.tokenAddress)), JSON.stringify({ blockchain: sent.blockchain, tokenAddress: sent.tokenAddress }));
  check("the request carries the wallet, the exact amount, the destination, the fee level and the idempotency key", sent.walletId === "wallet_1" && JSON.stringify(sent.amount) === '["0.5"]' && sent.destinationAddress === to && sent.fee?.config?.feeLevel === "MEDIUM" && sent.idempotencyKey === key);
  check("a payment Circle accepts comes back as a success with its transaction id", out.state === "success" || out.state === "pending", JSON.stringify(out));

  const whole = await t.sendTreasuryUsdc(row, to, 10, key);
  check("whole amounts are sent without trailing zeros ('10', not '10.000000')", JSON.stringify(calls[1]?.amount) === '["10"]' && whole.state !== undefined);

  nextError = Object.assign(new Error("Request failed with status code 400"), { response: { data: { message: "insufficient funds" } } });
  const failed = await t.sendTreasuryUsdc(row, to, 0.5, key);
  check("when Circle refuses, the payment is reported as failed with a reason, never as paid", failed.state === "failed" && !!failed.error, JSON.stringify(failed));

  // The run has to answer inside the server's limit
  const agent = read("src/lib/business/agent.ts");
  const treasury = read("src/lib/business/treasury.ts");
  const route = read("src/app/api/business/[id]/route.ts");
  const modelBudget = Number(/const MODEL_BUDGET_MS = ([\d_]+);/.exec(agent)?.[1].replace(/_/g, ""));
  const confirmWait = Number(/const CONFIRM_WAIT_MS = ([\d_]+);/.exec(treasury)?.[1].replace(/_/g, ""));
  check("the model's time is bounded (all candidates together, each call abortable) so a slow model falls back to the next one or the rules", modelBudget > 0 && modelBudget <= 15_000 && agent.includes("abortSignal: AbortSignal.timeout(left)") && agent.includes("maxRetries: 0"), "budget " + modelBudget);
  check("a payment waits only a few seconds for Arc to confirm (the next run settles a slower one), and the model plus one payment fit well inside 30 s", confirmWait > 0 && confirmWait <= 12_000 && modelBudget + confirmWait <= 25_000, `model ${modelBudget} ms + confirm ${confirmWait} ms`);
  check("the Business route allows a longer request than the default, like the chat route", /export const maxDuration = (\d+);/.test(route) && Number(/export const maxDuration = (\d+);/.exec(route)[1]) >= 60);

  finish();
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(1);
});
