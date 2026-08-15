const DOMA_ENV = process.env.DOMA_ENV === "testnet" ? "testnet" : "mainnet";

export const DOMA_API_BASE = (
  process.env.DOMA_API_BASE ??
  (DOMA_ENV === "mainnet" ? "https://api.doma.xyz" : "https://api-testnet.doma.xyz")
).replace(/\/$/, "");

export const DOMA_GRAPHQL_URL = (
  process.env.DOMA_GRAPHQL_URL ?? `${DOMA_API_BASE}/graphql`
).replace(/\/$/, "");

function domaHeaders(json = true) {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (json) headers["Content-Type"] = "application/json";
  if (process.env.DOMA_API_KEY) headers["Api-Key"] = process.env.DOMA_API_KEY;
  return headers;
}

async function domaRest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${DOMA_API_BASE}${path}`, {
    ...init,
    headers: {
      ...domaHeaders(init?.body != null),
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(data?.message ?? data?.error ?? `Doma API ${res.status}`);
  }
  return data as T;
}

async function domaGraphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(DOMA_GRAPHQL_URL, {
    method: "POST",
    headers: domaHeaders(true),
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (!res.ok || json.errors?.length) {
    throw new Error(json.errors?.[0]?.message ?? `Doma GraphQL ${res.status}`);
  }
  return json.data as T;
}

const NAME_FIELDS = `
  items {
    name
    tokenId
    tokenAddress
    claimStatus
    expiresAt
    networkId
    ownerAddress
    registrar { name ianaId }
    chain { name networkId }
  }
  totalCount
`;

const LISTING_FIELDS = `
  items {
    id
    externalId
    name
    tokenId
    tokenAddress
    price
    offererAddress
    orderbook
    expiresAt
    createdAt
    currency { symbol name decimals address }
    chain { name networkId }
    registrar { name ianaId }
  }
  totalCount
`;

const OFFER_FIELDS = `
  items {
    id
    externalId
    tokenId
    price
    offererAddress
    orderbook
    status
    expiresAt
    createdAt
    currency { symbol name decimals address }
  }
  totalCount
`;

const DOMA_NETWORKS = {
  mainnet: {
    chainId: "eip155:97477",
    currency: "ETH",
    bridge: "https://bridge.doma.xyz",
    rpc: "https://rpc.doma.xyz",
    explorer: "https://explorer.doma.xyz",
    api: "https://api.doma.xyz",
    graphql: "https://api.doma.xyz/graphql",
  },
  testnet: {
    chainId: "eip155:97476",
    currency: "ETH",
    bridge: "https://bridge-testnet.doma.xyz",
    rpc: "https://rpc-testnet.doma.xyz",
    explorer: "https://explorer-testnet.doma.xyz",
    api: "https://api-testnet.doma.xyz",
    graphql: "https://api-testnet.doma.xyz/graphql",
  },
} as const;

const DOMA_CONTRACTS = {
  mainnet: {
    doma: {
      chainId: 97477,
      domaRecord: "0xd000000000003eC7096c7B280b274F20b305b82a",
      crossChainGateway: "0xD000000000007f18154b96c65eBdF26963d4FbB4",
      forwarder: "0xd000000000bc34dBa2A100ab94cfdDc1e49266B9",
      ownershipToken: "0xd000000000009E6bEa0bA0c5D964AE98d59ED318",
      proxyDomaRecord: "0xd0000000000067CB44aE7b6aC3AB5764dE20A3E2",
    },
    base: {
      ownershipToken: "0xd000000000009E6bEa0bA0c5D964AE98d59ED318",
      proxyDomaRecord: "0xd0000000000067CB44aE7b6aC3AB5764dE20A3E2",
      crossChainGateway: "0xD000000000007f18154b96c65eBdF26963d4FbB4",
    },
    avalanche: {
      ownershipToken: "0xd000000000009E6bEa0bA0c5D964AE98d59ED318",
      proxyDomaRecord: "0xd0000000000067CB44aE7b6aC3AB5764dE20A3E2",
      crossChainGateway: "0xD000000000007f18154b96c65eBdF26963d4FbB4",
    },
    shibarium: {
      ownershipToken: "0xDe74799371Ceac11A0F52BA2694392A391D0dA18",
      proxyDomaRecord: "0xd0000000000067CB44aE7b6aC3AB5764dE20A3E2",
      crossChainGateway: "0xD000000000007f18154b96c65eBdF26963d4FbB4",
    },
    core: {
      ownershipToken: "0x2fa82373Ff812613FCcf2bBBe6DEC8267EcBa2dc",
      proxyDomaRecord: "0xd0000000000067CB44aE7b6aC3AB5764dE20A3E2",
      crossChainGateway: "0xD000000000007f18154b96c65eBdF26963d4FbB4",
    },
    apechain: {
      ownershipToken: "0x0D435A6c16045Abeaf6A442Bf162fd52597B4Ed3",
      proxyDomaRecord: "0xd0000000000067CB44aE7b6aC3AB5764dE20A3E2",
      crossChainGateway: "0xD000000000007f18154b96c65eBdF26963d4FbB4",
    },
    viction: {
      ownershipToken: "0x619F26d2c0E9C0102aD7924A63c5834776167292",
      proxyDomaRecord: "0xd0000000000067CB44aE7b6aC3AB5764dE20A3E2",
      crossChainGateway: "0xD000000000007f18154b96c65eBdF26963d4FbB4",
    },
  },
  testnet: {
    doma: {
      chainId: 97476,
      domaRecord: "0xF6A92E0f8bEa4174297B0219d9d47fEe335f84f8",
      crossChainGateway: "0xCE1476C791ff195e462632bf9Eb22f3d3cA07388",
      forwarder: "0xf17beC16794e018E2F0453a1282c3DA3d121f410",
      ownershipToken: "0x424bDf2E8a6F52Bd2c1C81D9437b0DC0309DF90f",
      proxyDomaRecord: "0xb1508299A01c02aC3B70c7A8B0B07105aaB29E99",
    },
    sepolia: {
      ownershipToken: "0x9A374915648f1352827fFbf0A7bB5752b6995eB7",
      proxyDomaRecord: "0xD9A0E86AACf2B01013728fcCa9F00093B9b4F3Ff",
      crossChainGateway: "0xEC67EfB227218CCc3c7032a6507339E7B4D623Ad",
    },
    baseSepolia: {
      ownershipToken: "0x2f45DfC5f4c9473fa72aBdFbd223d0979B265046",
      proxyDomaRecord: "0xa40aA710F0C77DF3De6CEe7493d1FfF3715D59Da",
      crossChainGateway: "0xC721925DF8268B1d4a1673D481eB446B3EDaAAdE",
    },
    avalancheFuji: {
      ownershipToken: "0x4a6702E57081F6677D4b75D902223ffBF026efea",
      proxyDomaRecord: "0x005815F7de38F192260b26005444cD62126D3D8A",
      crossChainGateway: "0x1443bC2bBAB07437BCF9C577b647523A736bB33E",
    },
    shibariumPuppynet: {
      ownershipToken: "0x55460792B2e3eDEbdF28f6C8766B7778Db7092A9",
      proxyDomaRecord: "0x8420729Dc9eBb5a30dBa8CEe1392F56bfc03b1F5",
      crossChainGateway: "0x79e70acd155bFA071E57cA6a2f507d87d0e7B7f9",
    },
    apechainTestnet: {
      ownershipToken: "0x63b7749B3b79B974904E0c684Ee589191fd807b4",
      proxyDomaRecord: "0x797293E811f9C5eFa1973004B581E46d1787F929",
      crossChainGateway: "0xa483D7d32D7f5f2bd430CA9e61db275Eda72Fd23",
    },
  },
} as const;

const SUPPORTED_GTLD_TEXT = ".academy .accountant .accountants .actor .adult .africa .agency .airforce .apartments .app .army .art .associates .attorney .auction .audio .author .auto .autos .baby .band .bar .bargains .beauty .beer .best .bet .bible .bid .bike .bingo .bio .biz .black .blackfriday .blog .blue .boo .book .boston .bot .boutique .box .broker .build .builders .business .buy .buzz .cab .cafe .call .cam .camera .camp .cancerresearch .capital .car .cards .care .career .careers .cars .casa .cash .casino .catering .catholic .center .ceo .cfd .channel .chat .cheap .christmas .church .circle .city .claims .cleaning .click .clinic .clothing .cloud .club .coach .codes .coffee .college .com .community .company .computer .condos .construction .consulting .contact .contractors .cooking .cool .country .coupon .coupons .courses .credit .creditcard .cricket .cruise .cruises .dad .dance .data .date .dating .day .deal .deals .degree .delivery .democrat .dental .dentist .design .dev .diamonds .diet .digital .direct .directory .discount .diy .docs .doctor .dog .domains .dot .download .earth .eat .education .email .energy .engineer .engineering .edeka .enterprises .equipment .estate .events .exchange .expert .exposed .express .fail .faith .family .fan .fans .farm .fashion .feedback .film .final .finance .financial .fish .fishing .fit .fitness .flights .florist .flowers .food .football .forsale .forum .foundation .free .fun .fund .furniture .fyi .gallery .game .games .garden .gay .gdn .gift .gifts .gives .glass .global .gmbh .gold .golf .gop .graphics .gripe .group .guide .guitars .guru .hair .haus .health .healthcare .help .here .hiphop .hiv .hockey .holdings .holiday .homes .horse .hospital .host .hosting .hot .house .how .industries .info .ing .ink .institute .insurance .insure .international .investments .jewelry .joy .kim .kitchen .land .lat .lawyer .lease .legal .lgbt .life .lifeinsurance .lighting .like .limited .limo .link .live .living .llc .loan .loans .lol .lotto .love .ltd .makeup .management .map .market .marketing .markets .mba .med .media .meet .meme .memorial .men .menu .mobile .moda .moe .mom .money .monster .mortgage .motorcycles .mov .movie .navy .net .network .news .nexus .ninja .now .observer .one .onl .online .ooo .open .org .page .partners .parts .party .pay .pet .phone .photo .photography .photos .pics .pictures .pid .pin .pink .pizza .place .plumbing .plus .poker .press .pro .productions .prof .promo .properties .property .protection .pub .qpon .quebec .racing .read .realestate .realty .recipes .red .rehab .rent .rentals .repair .report .republican .rest .restaurant .review .reviews .rich .rip .rocks .rodeo .room .rugby .run .safe .sale .save .sbi .scholarships .school .science .search .secure .security .select .services .sexy .shoes .shop .shopping .show .singles .site .ski .skin .sky .soccer .social .software .solar .solutions .song .space .spreadbetting .spot .srl .store .studio .study .style .sucks .supplies .supply .support .surf .surgery .systems .talk .tattoo .tax .taxi .team .tech .technology .tennis .theater .theatre .tickets .tips .tires .today .tools .top .tours .town .toys .trade .trading .training .trust .tube .tunes .uconnect .university .uno .vacations .ventures .vet .video .villas .vip .vision .vodka .voting .voyage .wang .watch .watches .webcam .website .wedding .win .wine .work .works .world .wow .wtf .xyz .yachts .yoga .you";

const SUPPORTED_CCTLD_TEXT = ".ac .ad .ag .ai .al .am .ar .as .az .bz .ca .cc .cd .co .cu .cv .de .dj .fm .ga .gg .io .il .in .is .it .kg .ky .la .ly .ma .md .me .mn .ms .mt .ne .nu .pa .pe .pn .pr .pw .re .rs .sc .sd .sh .sx .tf .tk .tm .tn .to .tv .ws .yt";

const SUPPORTED_TLDS = [...SUPPORTED_GTLD_TEXT.split(" "), ...SUPPORTED_CCTLD_TEXT.split(" ")]
  .map((tld) => tld.replace(/^\./, ""))
  .sort();

export function getDomaConfig() {
  return {
    env: DOMA_ENV,
    apiBase: DOMA_API_BASE,
    graphqlUrl: DOMA_GRAPHQL_URL,
    hasApiKey: Boolean(process.env.DOMA_API_KEY),
    network: DOMA_NETWORKS[DOMA_ENV],
    contracts: DOMA_CONTRACTS[DOMA_ENV],
  };
}

export function getDomaNetworkInfo() {
  return {
    env: DOMA_ENV,
    network: DOMA_NETWORKS[DOMA_ENV],
    contracts: DOMA_CONTRACTS[DOMA_ENV],
    smartContractCapabilities: [
      "Doma Record: registrar-facing domain lifecycle coordination and Name Token issuance",
      "Doma Forwarder: optional EIP-2771 trusted forwarder for registrar meta-transactions",
      "Doma Gateway: ERC-7786 cross-chain messaging for supported tokenization chains",
      "Proxy Doma Record: user-facing claim, bridge, and domain-management operations on tokenization chains",
    ],
  };
}

export function getDomaSupportedTlds(query?: string) {
  const normalized = query?.trim().replace(/^\./, "").toLowerCase();
  const gtlds = SUPPORTED_GTLD_TEXT.split(" ").map((tld) => tld.replace(/^\./, ""));
  const ccTlds = SUPPORTED_CCTLD_TEXT.split(" ").map((tld) => tld.replace(/^\./, ""));
  return {
    tlds: normalized ? SUPPORTED_TLDS.filter((tld) => tld.includes(normalized)) : SUPPORTED_TLDS,
    gtldCount: gtlds.length,
    ccTldCount: ccTlds.length,
    totalCount: SUPPORTED_TLDS.length,
  };
}

export function getDomaFractionalizationInfo() {
  return {
    env: DOMA_ENV,
    chain: DOMA_NETWORKS[DOMA_ENV],
    components: [
      {
        name: "Doma Fractionalization",
        role: "Core smart contract for converting a domain ownership NFT into fungible fractional tokens and handling buyouts/redemptions.",
      },
      {
        name: "Fractional Token",
        role: "ERC-20 token representing fractional exposure to a specific domain ownership token.",
      },
      {
        name: "Doma Launchpad",
        role: "Initial launch mechanism using a bonding curve before liquidity migration.",
      },
      {
        name: "Doma Vesting",
        role: "Vests allocations reserved for the original domain owner.",
      },
      {
        name: "USDC.e",
        role: "Stablecoin used for buyouts and redemption proceeds on Doma Chain.",
      },
      {
        name: "DEX liquidity",
        role: "Uniswap V3 on Doma Chain provides trading liquidity and price feeds for fractional tokens.",
      },
    ],
    useCases: [
      {
        action: "fractionalize",
        summary: "Convert a domain ownership NFT into ERC-20 fractional tokens, set supply/metadata, set a minimum buyout price, and launch liquidity.",
        requires: ["Domain ownership token on Doma Chain", "Wallet signature", "Fractionalization contract interaction"],
      },
      {
        action: "buyout",
        summary: "Buy out a fractionalized domain NFT by paying at least max(minimum buyout price, fully diluted value, TWAP fully diluted value).",
        formula: "buyoutPrice = max(MBP, FDV, FDVtwap)",
        requires: ["USDC.e", "Wallet signature", "Fractionalization contract interaction"],
      },
      {
        action: "redeem",
        summary: "After a buyout, holders can exchange old fractional tokens for their proportional USDC.e proceeds.",
        formula: "redeemPricePerToken = buyoutPrice / totalSupply",
        requires: ["Fractional tokens", "Wallet signature", "Fractionalization contract interaction"],
      },
    ],
    limitation: "Bluvfi exposes guidance and protocol data here; execution requires Doma fractionalization contract ABIs, live addresses, and user-signed wallet transactions.",
  };
}

export function getDomaLifecycleWorkflows() {
  return {
    env: DOMA_ENV,
    dashboards: {
      app: DOMA_ENV === "mainnet" ? "https://dashboard.doma.xyz" : "https://dashboard-testnet.doma.xyz",
      testnetRegistrar: "https://testnet.interstellar.xyz",
      bridge: DOMA_NETWORKS[DOMA_ENV].bridge,
    },
    workflows: [
      {
        name: "Tokenize a domain",
        steps: [
          "Buy or manage a supported domain through a registrar that integrates Doma Protocol.",
          "Choose the target tokenization chain.",
          "Sign the registrar-provided wallet request.",
          "Track tokenization with Doma command status or Poll API events until the name token is issued.",
        ],
        bluvfiSupport: ["getSupportedTlds", "generateMetadata", "registrant contact voucher helpers", "getCommand", "pollEvents"],
        requiresUserAction: ["Registrar account", "Wallet signature", "Registrar approval"],
      },
      {
        name: "Bridge a name token",
        steps: [
          "Select a tokenized domain and target chain.",
          "Provide the destination wallet address.",
          "Sign the bridge request.",
          "Track bridge progress by command status or Poll API events.",
        ],
        bluvfiSupport: ["getNetworkInfo", "getCommand", "pollEvents", "getTokenActivities"],
        requiresUserAction: ["Wallet signature", "Supported source and destination chains"],
      },
      {
        name: "Claim a transferred domain",
        steps: [
          "Verify the owner email and prepare registrant contact data.",
          "Upload contacts to receive a proof-of-contacts voucher.",
          "Sign the claim request.",
          "Track registrar approval or rejection.",
        ],
        bluvfiSupport: ["initiateEmailVerification", "completeEmailVerification", "uploadRegistrantContacts", "uploadVerifiedRegistrantContacts", "getCommand", "pollEvents"],
        requiresUserAction: ["Email verification", "Private contact details", "Wallet signature", "Registrar approval"],
      },
      {
        name: "List, sell, buy, or accept offers",
        steps: [
          "Browse listings or offers.",
          "Prepare fulfillment data for a buy or offer acceptance.",
          "Sign the order or fulfillment request with the user wallet.",
          "Track marketplace and ownership events.",
        ],
        bluvfiSupport: ["getListings", "getOffers", "getNameStatistics", "getListingFulfillment", "getOfferFulfillment", "createListing", "createOffer", "cancelListing", "cancelOffer", "bulk orders"],
        requiresUserAction: ["Wallet signature", "Sufficient payment balance", "API key for authenticated orderbook writes"],
      },
      {
        name: "Detokenize a domain",
        steps: [
          "Confirm the user wants to remove the domain from Web3 trading.",
          "Use Doma dashboard or the supported smart-contract flow for the tokenized domain.",
          "Sign the detokenization request.",
          "Track completion through command status or lifecycle events.",
        ],
        bluvfiSupport: ["getName", "getToken", "getCommand", "pollEvents"],
        requiresUserAction: ["Wallet signature", "Registrar/Doma dashboard flow", "Registrar rules"],
      },
    ],
    limitation: "Bluvfi can prepare data, track statuses, and submit supported Doma API calls. Direct tokenization, bridge, claim, detokenize, and fractionalization execution still requires user wallet signatures and Doma/registrar contract or dashboard flows.",
  };
}

export function searchDomaNames(params: {
  name?: string;
  ownedBy?: string[];
  tlds?: string[];
  claimStatus?: "CLAIMED" | "UNCLAIMED" | "ALL";
  skip?: number;
  take?: number;
}) {
  return domaGraphql<unknown>(
    `query SearchNames($skip: Int, $take: Int, $name: String, $ownedBy: [AddressCAIP10!], $tlds: [String!], $claimStatus: NamesQueryClaimStatus) {
      names(skip: $skip, take: $take, name: $name, ownedBy: $ownedBy, tlds: $tlds, claimStatus: $claimStatus) {
        ${NAME_FIELDS}
      }
    }`,
    {
      skip: params.skip ?? 0,
      take: Math.min(params.take ?? 20, 100),
      name: params.name || undefined,
      ownedBy: params.ownedBy?.length ? params.ownedBy : undefined,
      tlds: params.tlds?.length ? params.tlds : undefined,
      claimStatus: params.claimStatus ?? "ALL",
    },
  );
}

export function getDomaName(name: string) {
  return domaGraphql<unknown>(
    `query Name($name: String!) {
      name(name: $name) {
        name
        tokenId
        tokenAddress
        claimStatus
        expiresAt
        networkId
        ownerAddress
        registrar { name ianaId }
        chain { name networkId }
      }
    }`,
    { name },
  );
}

export function getDomaTokens(name: string, skip = 0, take = 20) {
  return domaGraphql<unknown>(
    `query Tokens($name: String!, $skip: Int, $take: Int) {
      tokens(name: $name, skip: $skip, take: $take) {
        items {
          tokenId
          tokenAddress
          ownerAddress
          networkId
          expiresAt
        }
        totalCount
      }
    }`,
    { name, skip, take: Math.min(take, 100) },
  );
}

export function getDomaNameActivities(params: {
  name: string;
  type?: "TOKENIZED" | "CLAIMED" | "RENEWED" | "DETOKENIZED";
  skip?: number;
  take?: number;
  sortOrder?: "ASC" | "DESC";
}) {
  return domaGraphql<unknown>(
    `query NameActivities($name: String!, $skip: Float, $take: Float, $type: NameActivityType, $sortOrder: SortOrderType) {
      nameActivities(name: $name, skip: $skip, take: $take, type: $type, sortOrder: $sortOrder) {
        items {
          type
          txHash
          sld
          tld
          createdAt
          networkId
        }
        totalCount
      }
    }`,
    {
      name: params.name,
      type: params.type,
      skip: params.skip ?? 0,
      take: Math.min(params.take ?? 20, 100),
      sortOrder: params.sortOrder ?? "DESC",
    },
  );
}

export function getDomaToken(tokenId: string) {
  return domaGraphql<unknown>(
    `query Token($tokenId: String!) {
      token(tokenId: $tokenId) {
        tokenId
        tokenAddress
        ownerAddress
        networkId
        type
        startsAt
        expiresAt
        explorerUrl
        activities { type networkId txHash finalized tokenId createdAt }
      }
    }`,
    { tokenId },
  );
}

export function getDomaTokenActivities(params: {
  tokenId: string;
  type?: "MINTED" | "TRANSFERRED" | "LISTED" | "OFFER_RECEIVED" | "LISTING_CANCELLED" | "OFFER_CANCELLED" | "PURCHASED";
  skip?: number;
  take?: number;
  sortOrder?: "ASC" | "DESC";
}) {
  return domaGraphql<unknown>(
    `query TokenActivities($tokenId: String!, $skip: Float, $take: Float, $type: TokenActivityType, $sortOrder: SortOrderType) {
      tokenActivities(tokenId: $tokenId, skip: $skip, take: $take, type: $type, sortOrder: $sortOrder) {
        items {
          type
          networkId
          txHash
          finalized
          tokenId
          createdAt
        }
        totalCount
      }
    }`,
    {
      tokenId: params.tokenId,
      type: params.type,
      skip: params.skip ?? 0,
      take: Math.min(params.take ?? 20, 100),
      sortOrder: params.sortOrder ?? "DESC",
    },
  );
}

export function getDomaCommand(correlationId: string) {
  return domaGraphql<unknown>(
    `query Command($correlationId: String!) {
      command(correlationId: $correlationId) {
        correlationId
        type
        status
        createdAt
        updatedAt
      }
    }`,
    { correlationId },
  );
}

export function generateDomaMetadata(tokens: Array<{
  name: string;
  networkId: string;
  type: "OWNERSHIP" | "SYNTHETIC";
  startsAt?: string;
  expiresAt: string;
}>) {
  return domaGraphql<unknown>(
    `mutation GenerateMetadata($tokens: [TokenMetadataGenerationRequestInput!]!) {
      generateMetadata(tokens: $tokens)
    }`,
    { tokens },
  );
}

export function initiateDomaEmailVerification(email: string) {
  return domaGraphql<unknown>(
    `mutation InitiateEmailVerification($email: String!) {
      initiateEmailVerification(email: $email)
    }`,
    { email },
  );
}

export function completeDomaEmailVerification(params: { email: string; code: string }) {
  return domaGraphql<unknown>(
    `mutation CompleteEmailVerification($email: String!, $code: String!) {
      completeEmailVerification(email: $email, code: $code)
    }`,
    params,
  );
}

export function uploadDomaRegistrantContacts(params: {
  contact: Record<string, unknown>;
  emailVerificationProof: string;
  networkId: string;
  registrarIanaId: number;
}) {
  return domaGraphql<unknown>(
    `mutation UploadRegistrantContacts($contact: RegistrantContactInput!, $emailVerificationProof: String!, $networkId: String!, $registrarIanaId: Int!) {
      uploadRegistrantContacts(contact: $contact, emailVerificationProof: $emailVerificationProof, networkId: $networkId, registrarIanaId: $registrarIanaId) {
        proofOfContactsVoucher {
          registrantHandle
          nonce
          publicKey
          proofSource
          expiresAt
        }
        signature
      }
    }`,
    params,
  );
}

export function uploadDomaVerifiedRegistrantContacts(params: {
  contact: Record<string, unknown>;
  networkId: string;
  registrarIanaId: number;
}) {
  return domaGraphql<unknown>(
    `mutation UploadVerifiedRegistrantContacts($contact: RegistrantContactInput!, $networkId: String!, $registrarIanaId: Int!) {
      uploadVerifiedRegistrantContacts(contact: $contact, networkId: $networkId, registrarIanaId: $registrarIanaId) {
        proofOfContactsVoucher {
          registrantHandle
          nonce
          publicKey
          proofSource
          expiresAt
        }
        signature
      }
    }`,
    params,
  );
}

export function getDomaListings(params: {
  sld?: string;
  tlds?: string[];
  networkIds?: string[];
  registrarIanaIds?: number[];
  skip?: number;
  take?: number;
}) {
  return domaGraphql<unknown>(
    `query Listings($skip: Float, $take: Float, $sld: String, $tlds: [String!], $networkIds: [String!], $registrarIanaIds: [Int!]) {
      listings(skip: $skip, take: $take, sld: $sld, tlds: $tlds, networkIds: $networkIds, registrarIanaIds: $registrarIanaIds) {
        ${LISTING_FIELDS}
      }
    }`,
    {
      skip: params.skip ?? 0,
      take: Math.min(params.take ?? 20, 100),
      sld: params.sld || undefined,
      tlds: params.tlds?.length ? params.tlds : undefined,
      networkIds: params.networkIds?.length ? params.networkIds : undefined,
      registrarIanaIds: params.registrarIanaIds?.length ? params.registrarIanaIds : undefined,
    },
  );
}

export function getDomaOffers(params: {
  tokenId?: string;
  offeredBy?: string[];
  status?: "ACTIVE" | "EXPIRED" | "ALL";
  skip?: number;
  take?: number;
}) {
  return domaGraphql<unknown>(
    `query Offers($tokenId: String, $offeredBy: [AddressCAIP10!], $status: OfferStatus, $skip: Float, $take: Float) {
      offers(tokenId: $tokenId, offeredBy: $offeredBy, status: $status, skip: $skip, take: $take) {
        ${OFFER_FIELDS}
      }
    }`,
    {
      tokenId: params.tokenId || undefined,
      offeredBy: params.offeredBy?.length ? params.offeredBy : undefined,
      status: params.status ?? "ACTIVE",
      skip: params.skip ?? 0,
      take: Math.min(params.take ?? 20, 100),
    },
  );
}

export function getDomaNameStatistics(tokenId: string) {
  return domaGraphql<unknown>(
    `query NameStatistics($tokenId: String!) {
      nameStatistics(tokenId: $tokenId) {
        tokenId
        floorPrice
        highestOffer
        lastSalePrice
        listingsCount
        offersCount
      }
    }`,
    { tokenId },
  );
}

export function getDomaOrderbookFees(params: {
  orderbook: string;
  chainId: string;
  contractAddress: string;
}) {
  return domaRest<unknown>(
    `/v1/orderbook/fee/${encodeURIComponent(params.orderbook)}/${encodeURIComponent(params.chainId)}/${encodeURIComponent(params.contractAddress)}`,
  );
}

export function getDomaSupportedCurrencies(params: {
  chainId: string;
  contractAddress: string;
  orderbook: string;
}) {
  return domaRest<unknown>(
    `/v1/orderbook/currencies/${encodeURIComponent(params.chainId)}/${encodeURIComponent(params.contractAddress)}/${encodeURIComponent(params.orderbook)}`,
  );
}

export function getDomaListingFulfillment(params: { orderId: string; buyer: string }) {
  return domaRest<unknown>(
    `/v1/orderbook/listing/${encodeURIComponent(params.orderId)}/${encodeURIComponent(params.buyer)}`,
  );
}

export function getDomaOfferFulfillment(params: { orderId: string; fulfiller: string }) {
  return domaRest<unknown>(
    `/v1/orderbook/offer/${encodeURIComponent(params.orderId)}/${encodeURIComponent(params.fulfiller)}`,
  );
}

export function createDomaListing(params: {
  orderbook: "DOMA" | "OPENSEA" | string;
  chainId: string;
  parameters: Record<string, unknown>;
  signature: string;
  cancelExisting: boolean;
  cancelSignatures?: Record<string, string>;
}) {
  return domaRest<unknown>("/v1/orderbook/list", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function createDomaOffer(params: {
  orderbook: "DOMA" | "OPENSEA" | string;
  chainId: string;
  parameters: Record<string, unknown>;
  signature: string;
  cancelExisting: boolean;
  cancelSignatures?: Record<string, string>;
}) {
  return domaRest<unknown>("/v1/orderbook/offer", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function cancelDomaListing(params: { orderId: string; signature: string }) {
  return domaRest<unknown>("/v1/orderbook/listing/cancel", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function cancelDomaOffer(params: { orderId: string; signature: string }) {
  return domaRest<unknown>("/v1/orderbook/offer/cancel", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function createDomaBulkListings(params: {
  orderbook: "DOMA" | "OPENSEA";
  chainId: string;
  orders: Array<Record<string, unknown>>;
  cancelExisting: boolean;
  cancelSignatures?: Record<string, string>;
}) {
  return domaRest<unknown>("/v1/orderbook/list/bulk", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function createDomaBulkOffers(params: {
  orderbook: "DOMA" | "OPENSEA";
  chainId: string;
  orders: Array<Record<string, unknown>>;
  cancelExisting: boolean;
  cancelSignatures?: Record<string, string>;
}) {
  return domaRest<unknown>("/v1/orderbook/offer/bulk", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function getDomaBulkListingItems(id: string) {
  return domaRest<unknown>(`/v1/orderbook/list/bulk/${encodeURIComponent(id)}/items`);
}

export function getDomaBulkOfferItems(id: string) {
  return domaRest<unknown>(`/v1/orderbook/offer/bulk/${encodeURIComponent(id)}/items`);
}

export function pollDomaEvents(params?: {
  cursor?: string;
  limit?: number;
  finalizedOnly?: boolean;
  includeSynthetics?: boolean;
  eventTypes?: string[];
}) {
  const qs = new URLSearchParams();
  if (params?.cursor) qs.set("cursor", params.cursor);
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.finalizedOnly != null) qs.set("finalizedOnly", String(params.finalizedOnly));
  if (params?.includeSynthetics != null) qs.set("includeSynthetics", String(params.includeSynthetics));
  for (const eventType of params?.eventTypes ?? []) qs.append("eventTypes", eventType);
  return domaRest<unknown>(`/v1/poll${qs.size ? `?${qs}` : ""}`);
}

export function acknowledgeDomaEvents(params: { lastEventId: number; cursor?: string }) {
  const qs = new URLSearchParams();
  if (params.cursor) qs.set("cursor", params.cursor);
  return domaRest<unknown>(
    `/v1/poll/ack/${encodeURIComponent(String(params.lastEventId))}${qs.size ? `?${qs}` : ""}`,
    { method: "POST" },
  );
}

export function resetDomaEventCursor(params: { eventId: number; cursor?: string }) {
  const qs = new URLSearchParams();
  if (params.cursor) qs.set("cursor", params.cursor);
  return domaRest<unknown>(
    `/v1/poll/reset/${encodeURIComponent(String(params.eventId))}${qs.size ? `?${qs}` : ""}`,
    { method: "POST" },
  );
}
