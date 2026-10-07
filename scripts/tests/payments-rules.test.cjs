/**
 * Money rules (src/lib/payments-rules.ts): amounts, the 80/20 split, drift, and which addresses may be paid. No database.
 *
 *     node scripts/tests/payments-rules.test.cjs
 */
const { makeLoader, reporter } = require("./_harness.cjs");
const rules = makeLoader({})("src/lib/payments-rules.ts");
const { PAYMENTS, usdToMicro, microToDecimal, splitPrice, isValidPriceMicro, driftBps, usdPerSkr, isPayableAddress, SKR_MINT, USDC_MINT } = rules;
const { check, finish } = reporter();

check("owner share is 80%", PAYMENTS.ownerBps === 8000);
check("minimum withdrawal is $5 and minimum top-up is $1", PAYMENTS.minWithdrawMicro === 5_000_000 && PAYMENTS.minTopupMicro === 1_000_000);

// usdToMicro: exact, strict
for (const [text, micro] of [["0", 0], ["1", 1_000_000], ["0.05", 50_000], ["0.000001", 1], ["5", 5_000_000], ["12.3456", 12_345_600], ["0.1", 100_000], ["0.30", 300_000]]) {
  check(`usdToMicro("${text}") = ${micro}`, usdToMicro(text) === micro, String(usdToMicro(text)));
}
for (const bad of ["", "abc", "-1", "1e3", "1.1234567", "1,5", ".5", "5.", " ", "0x10", "1 2", "Infinity", null, undefined, 5]) {
  check(`usdToMicro refuses ${JSON.stringify(bad)}`, usdToMicro(bad) === null);
}
check("0.1 + 0.2 style float noise cannot occur: 0.3 is exactly 300000", usdToMicro("0.3") === 300_000);

// microToDecimal: trimmed, no exponent
for (const [micro, text] of [[0, "0"], [1, "0.000001"], [50_000, "0.05"], [1_000_000, "1"], [12_345_600, "12.3456"], [5_000_000, "5"], [900_000_000, "900"], [-250_000, "-0.25"]]) {
  check(`microToDecimal(${micro}) = "${text}"`, microToDecimal(micro) === text, microToDecimal(micro));
}
let roundTrip = true;
for (let i = 0; i <= 5000; i++) if (usdToMicro(microToDecimal(i * 997)) !== i * 997) { roundTrip = false; break; }
check("usdToMicro(microToDecimal(n)) = n for thousands of amounts", roundTrip);

// splitPrice: exact, never loses a micro-USDC
for (const [price, owner, platform] of [[1_000_000, 800_000, 200_000], [50_000, 40_000, 10_000], [1, 0, 1], [3, 2, 1], [5, 4, 1], [7, 5, 2], [0, 0, 0], [5_000_000, 4_000_000, 1_000_000]]) {
  const s = splitPrice(price);
  check(`split of ${price}: owner ${owner} + Bluvfi ${platform}`, s.owner === owner && s.platform === platform, JSON.stringify(s));
}
let exact = true;
let ownerNeverMore = true;
for (let n = 0; n <= 200_000; n++) {
  const s = splitPrice(n);
  if (s.owner + s.platform !== n) exact = false;
  if (s.owner > n * 0.8 + 1e-9) ownerNeverMore = false;
}
check("owner + Bluvfi equals the price for every price from 0 to 200,000", exact);
check("the owner is never paid more than 80% (rounding always goes Bluvfi's way)", ownerNeverMore);
check("a bad price splits to nothing instead of throwing", [-1, 1.5, NaN, Infinity].every((n) => splitPrice(n).owner === 0 && splitPrice(n).platform === 0));

check("valid prices: 0 up to $5, whole micro only", isValidPriceMicro(0) && isValidPriceMicro(5_000_000) && !isValidPriceMicro(5_000_001) && !isValidPriceMicro(-1) && !isValidPriceMicro(1.5) && !isValidPriceMicro("5"));

// price drift (the safety check between the admin's review and the click)
check("no drift when nothing moved", driftBps(1_000_000, 1_000_000) === 0);
check("a 3% move is 300 bps", driftBps(1_000_000, 1_030_000) === 300 && driftBps(1_000_000, 970_000) === 300);
check("drift of an impossible expectation is infinite (refuse)", driftBps(0, 5) === Infinity);

// usd per skr
check("1,000 SKR for $17.60 shows 0.0176 per SKR", usdPerSkr(17_600_000, 1_000_000_000) === "0.0176", usdPerSkr(17_600_000, 1_000_000_000));
check("a zero quote gives 0, not a crash", usdPerSkr(1_000_000, 0) === "0");

// who can be paid
check("a normal wallet address is payable", isPayableAddress("5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM"));
for (const [label, a] of [["the System Program", "11111111111111111111111111111111"], ["the Token program", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], ["the SKR mint", SKR_MINT], ["the USDC mint", USDC_MINT], ["junk", "not-an-address"], ["empty", ""], ["a number", 12345]]) {
  check(`${label} is refused as a payout address`, !isPayableAddress(a));
}

finish();
