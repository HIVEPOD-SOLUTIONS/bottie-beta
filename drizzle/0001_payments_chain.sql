-- Add chain column to payments table to record which network was used
-- "evm" = Base mainnet via Arc AppKit, "solana" = Solana mainnet via user wallet
ALTER TABLE "payments" ADD COLUMN "chain" text;
