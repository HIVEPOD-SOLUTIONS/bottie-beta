import { createConfig } from "@privy-io/wagmi";
import { base } from "viem/chains";
import { http } from "wagmi";

const alchemyKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;

export const wagmiConfig = createConfig({
  chains: [base],
  transports: {
    [base.id]: http(
      alchemyKey
        ? `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`
        : undefined
    ),
  },
});
