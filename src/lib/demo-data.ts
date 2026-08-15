export type DemoAsset = {
  symbol: string;
  name: string;
  type: "stock" | "ipo" | "etf";
  priceUsd: number;
  change24h: number;
  description: string;
  icon: string;
};

export const DEMO_ASSETS: DemoAsset[] = [
  { symbol: "AAPL",   name: "Apple Inc.",       type: "stock", priceUsd: 182.50, change24h:  1.24, description: "Consumer electronics & software",  icon: "🍎" },
  { symbol: "TSLA",   name: "Tesla Inc.",        type: "stock", priceUsd: 247.80, change24h: -2.31, description: "Electric vehicles & clean energy",  icon: "⚡" },
  { symbol: "GOOGL",  name: "Alphabet Inc.",     type: "stock", priceUsd: 141.20, change24h:  0.87, description: "Search, cloud & AI",               icon: "🔍" },
  { symbol: "MSFT",   name: "Microsoft Corp.",   type: "stock", priceUsd: 378.90, change24h:  0.52, description: "Software, cloud & AI",             icon: "💻" },
  { symbol: "NVDA",   name: "NVIDIA Corp.",      type: "stock", priceUsd: 495.30, change24h:  3.14, description: "GPUs & AI chips",                  icon: "🎮" },
  { symbol: "AMZN",   name: "Amazon.com Inc.",   type: "stock", priceUsd: 185.40, change24h:  1.05, description: "E-commerce & cloud",               icon: "📦" },
  { symbol: "SPACEX", name: "SpaceX",            type: "ipo",   priceUsd: 185.00, change24h:  0.00, description: "Space exploration & Starlink",     icon: "🚀" },
  { symbol: "OPENAI", name: "OpenAI",            type: "ipo",   priceUsd: 150.00, change24h:  0.00, description: "Artificial intelligence research", icon: "🤖" },
  { symbol: "SPY",    name: "S&P 500 ETF",       type: "etf",   priceUsd: 498.20, change24h:  0.43, description: "Tracks the S&P 500 index",         icon: "📊" },
  { symbol: "QQQ",    name: "Nasdaq-100 ETF",    type: "etf",   priceUsd: 425.10, change24h:  0.71, description: "Tracks the Nasdaq-100 index",      icon: "📈" },
];

export const ASSET_PRICES: Record<string, number> = Object.fromEntries(
  DEMO_ASSETS.map((a) => [a.symbol, a.priceUsd])
);
