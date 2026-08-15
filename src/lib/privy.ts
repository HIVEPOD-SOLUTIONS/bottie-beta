import type { PrivyClientConfig } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { base } from "viem/chains";

export const privyConfig: PrivyClientConfig = {
  loginMethods: ["email", "google", "passkey"],
  appearance: {
    theme: "light",
    accentColor: "#8FAE82",
    walletChainType: "ethereum-and-solana",
    walletList: ["metamask", "coinbase_wallet", "rainbow"],
  },
  embeddedWallets: {
    ethereum: {
      createOnLogin: "users-without-wallets",
    },
    solana: {
      createOnLogin: "users-without-wallets",
    },
    showWalletUIs: false,
  },
  externalWallets: {
    solana: {
      connectors: toSolanaWalletConnectors(),
    },
  },
  defaultChain: base,
  supportedChains: [base],
};
