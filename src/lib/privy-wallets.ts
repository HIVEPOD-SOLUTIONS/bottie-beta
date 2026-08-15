"use client";

type WalletLike = {
  address?: string;
  walletClientType?: string;
  chainType?: string;
};

type LinkedAccountLike = WalletLike & {
  type?: string;
};

type PrivyUserLike = {
  wallet?: WalletLike;
  smartWallet?: WalletLike;
  linkedAccounts?: LinkedAccountLike[];
};

function isPrivyWallet(wallet: WalletLike | LinkedAccountLike | undefined) {
  return wallet?.walletClientType === "privy";
}

function isEthereumWallet(wallet: WalletLike | LinkedAccountLike | undefined) {
  return isPrivyWallet(wallet) && (wallet?.chainType === "ethereum" || !wallet?.chainType);
}

function isSolanaWallet(wallet: WalletLike | LinkedAccountLike | undefined) {
  return isPrivyWallet(wallet) && wallet?.chainType === "solana";
}

export function getPrivyEmbeddedWallets(user: PrivyUserLike | null | undefined, wallets: WalletLike[] = []) {
  const linkedAccounts = (user?.linkedAccounts ?? []).filter((account) => account.type === "wallet");

  const evmWallet =
    wallets.find(isEthereumWallet) ??
    linkedAccounts.find(isEthereumWallet) ??
    (isEthereumWallet(user?.wallet) ? user?.wallet : undefined);

  const solanaWallet = wallets.find(isSolanaWallet) ?? linkedAccounts.find(isSolanaWallet);

  return {
    evmWallet,
    evmAddress: evmWallet?.address,
    solanaWallet,
    solanaAddress: solanaWallet?.address,
    smartWalletAddress: user?.smartWallet?.address,
  };
}

