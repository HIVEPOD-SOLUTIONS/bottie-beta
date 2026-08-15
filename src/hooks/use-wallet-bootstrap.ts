"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCreateWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import { useCreateWallet as useCreateSolanaWallet } from "@privy-io/react-auth/solana";
import { getPrivyEmbeddedWallets } from "@/lib/privy-wallets";

const WALLET_BOOTSTRAP_TIMEOUT_MS = 20_000;
const bootstrapInflight = new Set<string>();

type WalletBootstrapStatus = "idle" | "creating" | "ready" | "error";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = window.setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(id);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(id);
        reject(error);
      },
    );
  });
}

export function useWalletBootstrap() {
  const { ready, authenticated, user } = usePrivy();
  const { wallets } = useWallets();
  const { createWallet: createEthereumWallet } = useCreateWallet();
  const { createWallet: createSolanaWallet } = useCreateSolanaWallet();
  const startedRef = useRef(false);
  const lastUserIdRef = useRef<string | undefined>(undefined);
  const [status, setStatus] = useState<WalletBootstrapStatus>("idle");
  const [error, setError] = useState<string | undefined>();
  const [createdEvmAddress, setCreatedEvmAddress] = useState<string | undefined>();
  const [createdSolanaAddress, setCreatedSolanaAddress] = useState<string | undefined>();

  const linkedAccounts = useMemo(
    () => ((user?.linkedAccounts as Array<{ type?: string; walletClientType?: string; chainType?: string }>) ?? []),
    [user?.linkedAccounts],
  );

  const walletState = useMemo(() => getPrivyEmbeddedWallets(user as any, wallets), [user, wallets]);
  const evmAddress = walletState.evmAddress ?? createdEvmAddress;
  const solanaAddress = walletState.solanaAddress ?? createdSolanaAddress;
  const hasEthereum = Boolean(evmAddress);
  const hasSolana = Boolean(solanaAddress);

  useEffect(() => {
    if (process.env.NODE_ENV === "production" || !ready || !authenticated || !user?.id) return;
    console.info("[wallet-bootstrap] Wallet state", {
      hasEthereum,
      hasSolana,
      evmAddress,
      solanaAddress,
      linkedWallets: linkedAccounts.filter((account) => account.type === "wallet").map((account) => ({
        address: "address" in account ? Boolean((account as { address?: string }).address) : false,
        chainType: account.chainType,
        walletClientType: account.walletClientType,
      })),
      connectedWallets: wallets.map((wallet) => ({
        address: Boolean(wallet.address),
        chainType: wallet.type, // ConnectedWallet uses `type` not `chainType`
        walletClientType: wallet.walletClientType,
      })),
    });
  }, [authenticated, evmAddress, hasEthereum, hasSolana, linkedAccounts, ready, solanaAddress, user?.id, wallets]);

  useEffect(() => {
    if (lastUserIdRef.current === user?.id) return;
    lastUserIdRef.current = user?.id;
    startedRef.current = false;
    setError(undefined);
    setStatus("idle");
    setCreatedEvmAddress(undefined);
    setCreatedSolanaAddress(undefined);
  }, [user?.id]);

  useEffect(() => {
    if (!ready || !authenticated || !user?.id) return;
    if (hasEthereum && hasSolana) {
      setError(undefined);
      setStatus("ready");
    } else if (status === "ready") {
      setStatus("idle");
    }
  }, [authenticated, hasEthereum, hasSolana, ready, status, user?.id]);

  const createMissingWallets = useCallback(async () => {
    if (!ready || !authenticated || !user?.id || startedRef.current) return;
    if (hasEthereum && hasSolana) {
      setError(undefined);
      setStatus("ready");
      return;
    }

    const key = `bluvfi:wallet-bootstrap:${user.id}`;
    if (bootstrapInflight.has(key)) {
      setStatus("creating");
      return;
    }

    setError(undefined);
    startedRef.current = true;
    bootstrapInflight.add(key);
    setStatus("creating");

    try {
      console.info("[wallet-bootstrap] Creating missing embedded wallets", {
        hasEthereum,
        hasSolana,
        linkedWallets: linkedAccounts.filter((account) => account.type === "wallet").map((account) => ({
          chainType: account.chainType,
          walletClientType: account.walletClientType,
        })),
        connectedWallets: wallets.map((wallet) => ({
          chainType: wallet.type, // ConnectedWallet uses `type` not `chainType`
          walletClientType: wallet.walletClientType,
        })),
      });

      if (!hasEthereum) {
        console.info("[wallet-bootstrap] Creating Ethereum embedded wallet");
        const wallet = await withTimeout(createEthereumWallet(), WALLET_BOOTSTRAP_TIMEOUT_MS, "Ethereum wallet creation");
        setCreatedEvmAddress(wallet.address);
      }

      if (!hasSolana) {
        console.info("[wallet-bootstrap] Creating Solana embedded wallet");
        const wallet = await withTimeout(createSolanaWallet().then((result) => result.wallet), WALLET_BOOTSTRAP_TIMEOUT_MS, "Solana wallet creation");
        setCreatedSolanaAddress(wallet.address);
      }

      setStatus("ready");
      console.info("[wallet-bootstrap] Embedded wallet bootstrap complete");
    } catch (error) {
      startedRef.current = false;
      const message = error instanceof Error ? error.message : String(error);
      setError(message);
      setStatus("error");
      console.warn("[wallet-bootstrap] Embedded wallet creation did not complete", {
        hasEthereum,
        hasSolana,
        error: message,
      });
    } finally {
      bootstrapInflight.delete(key);
    }
  }, [
    authenticated,
    createEthereumWallet,
    createSolanaWallet,
    hasEthereum,
    hasSolana,
    linkedAccounts,
    ready,
    user?.id,
    wallets,
  ]);

  return {
    ...walletState,
    evmAddress,
    solanaAddress,
    hasEthereum,
    hasSolana,
    missingWallet: ready && authenticated && (!hasEthereum || !hasSolana),
    status,
    error,
    createMissingWallets,
  };
}
