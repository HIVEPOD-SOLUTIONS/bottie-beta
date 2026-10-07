/**
 * A simulated Solana chain for tests: it signs with a real keypair, records exactly what would be broadcast, and can fail in every
 * way that matters for double-payment safety (send errors after landing, dropped transactions, timeouts, on-chain failures).
 */
const { req } = require("./_harness.cjs");
const web3 = req("@solana/web3.js");
const spl = req("@solana/spl-token");
const bs58 = ((m) => m.default ?? m)(req("bs58")); // bs58 exposes encode/decode under .default
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/** A chain that behaves like Solana in the ways that matter for double-payment safety. */
function fakeChain(opts = {}) {
  const treasury = web3.Keypair.generate();
  const state = {
    skr: BigInt(opts.skr ?? 1_000_000_000_000), // 1,000,000 SKR
    lamports: opts.lamports ?? 500_000_000,
    height: 1000,
    sendMode: "ok", // ok | throw_after_landing | throw_before_landing | drop (broadcast "succeeds" but never lands)
    confirmMode: "confirmed", // confirmed | failed | timeout
    landed: new Map(), // signature -> { err }
    sent: [], // every raw transaction offered to send()
    quote: (usd) => ({ skrMicro: Math.round(usd / 0.0176), priceImpactPct: 0.01 }), // $0.0176 per SKR
    blockhashCounter: 0,
  };
  const chain = {
    state,
    treasury,
    treasuryAddress: () => treasury.publicKey.toBase58(),
    balances: async () => ({ skrMicro: state.skr, lamports: state.lamports }),
    latestBlockhash: async () => ({ blockhash: bs58.encode(Buffer.alloc(32, ++state.blockhashCounter)), lastValidBlockHeight: state.height + 150 }),
    blockHeight: async () => state.height,
    sign: (tx) => tx.sign(treasury),
    send: async (raw) => {
      state.sent.push(Buffer.from(raw));
      const tx = web3.Transaction.from(raw);
      const sig = bs58.encode(tx.signatures[0].signature);
      if (state.sendMode === "throw_before_landing") throw new Error("socket hang up");
      if (state.sendMode === "drop") return;
      state.landed.set(sig, { err: null });
      if (state.sendMode === "throw_after_landing") throw new Error("socket hang up");
    },
    confirm: async (sig) => (state.confirmMode === "confirmed" && state.landed.has(sig) ? "confirmed" : state.confirmMode === "failed" ? "failed" : "timeout"),
    status: async (sig) => (state.landed.has(sig) ? { confirmed: true, err: state.landed.get(sig).err } : null),
    quoteSkr: async (usd) => state.quote(usd),
  };
  return chain;
}

/** Decodes a broadcast transaction into what it actually does. */
function decode(raw, treasuryKey) {
  const tx = web3.Transaction.from(raw);
  const ixs = tx.instructions;
  const transfer = ixs.find((i) => i.programId.equals(spl.TOKEN_PROGRAM_ID));
  const memo = ixs.find((i) => i.programId.toBase58() === MEMO);
  const t = transfer ? spl.decodeTransferCheckedInstruction(transfer) : null;
  return {
    tx,
    sigValid: tx.verifySignatures(),
    feePayer: tx.feePayer?.toBase58(),
    signerIsTreasury: tx.signatures[0].publicKey.equals(treasuryKey),
    count: ixs.length,
    first: ixs[0].programId.toBase58(),
    amount: t ? t.data.amount : null,
    decimals: t ? t.data.decimals : null,
    mint: t ? t.keys.mint.pubkey.toBase58() : null,
    source: t ? t.keys.source.pubkey.toBase58() : null,
    dest: t ? t.keys.destination.pubkey.toBase58() : null,
    authority: t ? t.keys.owner.pubkey.toBase58() : null,
    memo: memo ? memo.data.toString() : null,
    signature: bs58.encode(tx.signatures[0].signature),
  };
}


module.exports = { fakeChain, decode };
