/**
 * Pure rules for Shar (src/lib/shar-rules.ts): the SKR rate, the minimum claim and the amounts derived from them. No database needed.
 *
 *     node scripts/tests/shar-rules.test.cjs
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
const ts = require(path.join(ROOT, "node_modules", "typescript"));
const m = { exports: {} };
new Function("module", "exports", "require", ts.transpileModule(fs.readFileSync(path.join(ROOT, "src/lib/shar-rules.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(m, m.exports, require);
const { SHAR, skrForShar } = m.exports;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? `  -> ${detail}` : ""}`);
};

// An independent way to get the same answer: whole micro-SKR as a BigInt, then written out as a trimmed decimal.
const expected = (shar) => {
  const micro = BigInt(shar) * 900_000n; // 1 Shar = 0.9 SKR = 900,000 micro-SKR
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};

check("the rate is 1 Shar = 0.9 SKR", SHAR.skrPerShar === 0.9, String(SHAR.skrPerShar));
check("the minimum claim is 1,000 Shar", SHAR.minClaimShar === 1000, String(SHAR.minClaimShar));

for (const [shar, skr] of [[0, "0"], [1, "0.9"], [7, "6.3"], [50, "45"], [100, "90"], [350, "315"], [1000, "900"], [1234, "1110.6"], [12345, "11110.5"], [1_000_000_000, "900000000"]]) {
  check(`${shar} Shar = ${skr} SKR`, skrForShar(shar) === skr, skrForShar(shar));
}

// Float noise is the risk with a fractional rate: 1234 * 0.9 is 1110.6000000000001 in floating point.
let bad = null;
for (let n = 0; n <= 20_000; n++) {
  if (skrForShar(n) !== expected(n)) {
    bad = `${n}: got ${skrForShar(n)}, want ${expected(n)}`;
    break;
  }
}
check("every whole Shar amount from 0 to 20,000 matches an independent calculation exactly", bad === null, bad ?? "");
check("no exponent notation or long decimals ever appear", [1, 3, 7, 13, 99, 12345, 9_999_999].every((n) => /^\d+(\.\d{1,6})?$/.test(skrForShar(n))));

check("fractional Shar is floored, never rounded up (3.9 -> 3 -> 2.7)", skrForShar(3.9) === "2.7");
check("negative, NaN and Infinity give 0 rather than a bad amount", ["-5", NaN, Infinity, -Infinity].every((v) => skrForShar(Number(v)) === "0"));

check("the minimum claim is a whole number of Shar and pays 900 SKR", Number.isInteger(SHAR.minClaimShar) && skrForShar(SHAR.minClaimShar) === "900");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
