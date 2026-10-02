/**
 * POST /api/solana/transfer-usdc
 *
 * Builds an unsigned Solana USDC transfer transaction from the user's wallet
 * to the app's bill/investment receiver address (SOLANA_BILL_RECEIVER).
 *
 * The client signs the returned base64 transaction with their Privy Solana
 * wallet via useSignTransaction, then broadcasts it via the Solana RPC.
 *
 * Body: { from: string; amountUsdc: number }
 * Response: { transaction: string } — base64-encoded serialized Transaction
 */

import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

const SOLANA_RPC =
  process.env.FLASH_SOLANA_RPC ||
  `https://solana-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY}` ||
  "https://api.mainnet-beta.solana.com";

// USDC mint on Solana mainnet
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export async function POST(req: Request) {
  try {
    await verifyAuth();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const receiver = process.env.SOLANA_BILL_RECEIVER;
  if (!receiver) {
    return NextResponse.json(
      { error: "SOLANA_BILL_RECEIVER not configured — set a Solana address to receive payments" },
      { status: 503 },
    );
  }

  let body: { from?: string; amountUsdc?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { from, amountUsdc } = body;
  // Minimum is 1 base unit = $0.000001 USDC (USDC has 6 decimals)
  if (!from || !amountUsdc || amountUsdc < 0.000001) {
    return NextResponse.json(
      { error: "Missing required fields: from (Solana address), amountUsdc (≥ $0.000001)" },
      { status: 400 },
    );
  }

  try {
    const {
      Connection,
      PublicKey,
      Transaction,
    } = await import("@solana/web3.js");
    const {
      getOrCreateAssociatedTokenAccount,
      createTransferInstruction,
      getAssociatedTokenAddress,
    } = await import("@solana/spl-token");
    const bs58 = (await import("bs58")).default;

    // We need a payer keypair to create ATAs if they don't exist.
    // The app's agent wallet is used solely to create ATAs and set as fee payer
    // on the *build* step — the user signs and the final fee payer is overridden
    // to the user's wallet when they sign (Privy replaces feePayer on sign).
    // If SOLANA_AGENT_PRIVATE_KEY is not set, we require both ATAs to already exist.
    const agentKey = process.env.SOLANA_AGENT_PRIVATE_KEY;
    const { Keypair } = await import("@solana/web3.js");
    const payer = agentKey
      ? Keypair.fromSecretKey(bs58.decode(agentKey))
      : null;

    const connection = new Connection(SOLANA_RPC, "confirmed");
    const usdcMint = new PublicKey(USDC_MINT);
    const fromPubkey = new PublicKey(from);
    const toPubkey = new PublicKey(receiver);

    // Resolve ATAs — create if missing (payer covers creation fee)
    const [fromAta, toAta] = payer
      ? await Promise.all([
          getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, fromPubkey),
          getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, toPubkey),
        ])
      : await Promise.all([
          getAssociatedTokenAddress(usdcMint, fromPubkey).then((a) => ({ address: a })),
          getAssociatedTokenAddress(usdcMint, toPubkey).then((a) => ({ address: a })),
        ]);

    const baseUnits = BigInt(Math.round(amountUsdc * 1_000_000));
    const ix = createTransferInstruction(
      fromAta.address,
      toAta.address,
      fromPubkey,  // owner / authority = user
      baseUnits,
    );

    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: fromPubkey }).add(ix);

    // Serialize WITHOUT requiring all signatures (user hasn't signed yet)
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

    return NextResponse.json({ transaction: serialized.toString("base64") });
  } catch (err: unknown) {
    console.error("[Solana transfer-usdc] Error building tx:", err);
    return NextResponse.json(
      { error: (err as Error)?.message ?? "Failed to build transaction" },
      { status: 500 },
    );
  }
}
