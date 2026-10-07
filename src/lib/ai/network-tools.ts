import { tool } from "ai";
import { z } from "zod";
import { getBalanceMicro } from "@/lib/credits";
import { getEarnings } from "@/lib/earnings";
import { microToDecimal } from "@/lib/payments-rules";
import { getActivity } from "@/lib/activity-feed";
import { getCreator, listMine, listVerified, getProviderDetail } from "@/lib/provider-network";
import { PROVIDER_TERMS_VERSION } from "@/lib/provider-publisher-rules";
import { NETWORK, SORTS } from "@/lib/provider-network-rules";
import { getLeaderboard, getSummary, isMissingTable } from "@/lib/shar";

/**
 * Read-only tools for Shar (Bluvfi's reward unit) and the open provider network, so the agent answers from the user's real
 * numbers instead of guessing. Nothing here moves money or changes anything: claiming, withdrawing, adding credits and editing
 * providers all happen on the app's own screens, which the agent points to with bluvfi:// links.
 *
 * Tools never throw: a failure comes back as { error } with a message that is safe to relay.
 */

const SITE = "https://www.bluvfi.xyz";
const NOT_ON = { error: "Shar and the provider network aren't switched on yet. Tell the user it's coming soon." };
const fail = (err: unknown, label: string) => {
  if (isMissingTable(err)) return NOT_ON;
  console.error(`[ai/${label}]`, err instanceof Error ? err.message : err);
  return { error: "Couldn't load that right now. Ask the user to try again in a moment." };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a provider asks of the person using it, in words. Never includes credentials: those are not in this data. */
function setupFor(p: { inputFields?: unknown; requirements?: unknown; setupUrl?: string | null }) {
  const inputs = Array.isArray(p.inputFields) ? (p.inputFields as { key: string; label: string; type: string; required: boolean; help: string | null; choices: string[] | null; default: unknown }[]) : [];
  const steps = Array.isArray(p.requirements) ? (p.requirements as string[]) : [];
  return {
    inputs: inputs.map((f) => ({ name: f.key, label: f.label, type: f.type === "boolean" ? "yes/no" : f.type, required: f.required, help: f.help, options: f.choices, startingValue: f.default })),
    stepsBeforeUse: steps,
    setupLink: p.setupUrl ?? null,
  };
}

const amountText = (amount: number, unit: "shar" | "usd") => {
  const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  return unit === "shar" ? `${sign}${abs.toLocaleString("en-US")} Shar` : sign + "$" + microToDecimal(abs);
};

export function createNetworkTools(userId?: string) {
  return {
    get_my_shar: tool({
      description:
        "The user's Shar: how much they have available and pending, their rank (Spark, Wisp, Guide or Seeker), how much SKR it is worth, " +
        "whether they can claim it yet, any claim in progress, and their referral code and link. Use for any question about Shar, rewards, " +
        "claiming SKR or referrals. Do not estimate: always call this.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!userId) return { error: "Not signed in." };
        try {
          const s = await getSummary(userId);
          if (!s.ready) return NOT_ON;
          const board = await getLeaderboard(userId).catch(() => null);
          const open = s.claim.open;
          return {
            sharAvailable: s.available,
            sharPending: s.pending,
            sharLifetime: s.lifetime,
            sharThisWeek: s.week,
            weeklyTrial: board ? { yourRank: board.me.rank, resetsAt: board.weekEndsAt, note: "The weekly board resets every Monday at 00:00 UTC; only Shar earned that week counts." } : null,
            rank: s.tier,
            worthSkrIfClaimedNow: s.skr.availableSkr,
            skrPerShar: s.skr.perShar,
            minimumClaimShar: s.claim.minShar,
            canClaimNow: s.available >= s.claim.minShar && !open,
            claimInProgress: open ? { shar: open.shar, skr: open.skr, status: open.sending ? "SKR is on its way" : "waiting for the team to review" } : null,
            referral: s.referral.code
              ? { code: s.referral.code, link: `${SITE}/r/${s.referral.code}`, friendsJoined: s.referral.referred, bonusShar: s.referral.bonus }
              : null,
            fromProviders: s.provider,
            howItWorks: {
              earn: `${s.rules.perUsd} Shar per $1 spent on a purchase of $${s.rules.minPurchaseUsd} or more; ${s.rules.referralBonusPct}% of a friend's Shar; ${s.rules.providerUseShar} Shar each time someone uses a provider you added.`,
              openTheScreen: "bluvfi://shar",
            },
          };
        } catch (err) {
          return fail(err, "get_my_shar");
        }
      },
    }),

    search_network_providers: tool({
      description:
        "Search the open provider network: community-added providers and protocols that anyone can try inside Bluvfi (some free, some pay-per-call). " +
        "Use when the user wants to find, browse or compare providers (e.g. weather data, price feeds, translation). Returns the best matches; " +
        "each has a link the user can tap to open it.",
      inputSchema: z.object({
        query: z.string().max(NETWORK.searchMax).optional().describe("Words to look for in the name or description, e.g. 'weather'"),
        category: z.enum(NETWORK.categories).optional(),
        freeOnly: z.boolean().optional(),
        sort: z.enum(SORTS).optional().describe("featured (default), popular or new"),
        limit: z.number().int().min(1).max(10).optional().describe("How many to return, default 6"),
      }),
      execute: async ({ query, category, freeOnly, sort, limit }) => {
        if (!userId) return { error: "Not signed in." };
        try {
          const found = await listVerified(userId, { q: (query ?? "").trim(), category: category ?? null, sort: sort ?? "featured", free: freeOnly === true });
          return {
            count: found.length,
            providers: found.slice(0, limit ?? 6).map((p) => ({
              id: p.id,
              name: p.name,
              about: p.summary,
              category: p.category,
              pricePerCallUsdc: Number(p.priceUsdc) > 0 ? p.priceUsdc : "free",
              uses: p.uses,
              featured: p.featured,
              needsSetupFirst: Array.isArray(p.requirements) && p.requirements.length > 0,
              hasOwnerTerms: p.hasOwnerTerms === true,
              asksFor: Array.isArray(p.inputFields) ? p.inputFields.map((f: { label: string }) => f.label) : [],
              link: `bluvfi://provider/${p.id}`,
            })),
            openAll: "bluvfi://network",
          };
        } catch (err) {
          return fail(err, "search_network_providers");
        }
      },
    }),

    get_my_network_account: tool({
      description:
        "The user's side of the open provider network: their prepaid credits (used to pay for paid provider calls), the commission they've earned " +
        "from providers they added (they keep 80%, paid out as SKR), and their own providers with status and use. Use for questions about credits, " +
        "earnings, withdrawing commission, whether they're signed up as a provider creator, or 'how are my providers doing'.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!userId) return { error: "Not signed in." };
        try {
          const [credits, earnings, mine, creator] = await Promise.all([
            getBalanceMicro(userId),
            getEarnings(userId),
            listMine(userId),
            getCreator(userId).catch((err) => (isMissingTable(err) ? null : Promise.reject(err))),
          ]);
          return {
            // Adding a provider is an opt-in sign-up (free, a minute): who they are, a contact email, and the provider terms. You can't sign anyone up or agree for them.
            creator: creator
              ? { signedUp: true, listingAs: creator.operatorType === "company" ? creator.companyName : "an individual", mustAgreeToNewTerms: creator.termsVersion !== PROVIDER_TERMS_VERSION, editOn: "bluvfi://creator" }
              : { signedUp: false, becomeOne: "bluvfi://creator", note: "They need to sign up as a creator on the Network screen before they can add a provider." },
            creditsUsd: microToDecimal(credits),
            commission: {
              availableUsd: microToDecimal(earnings.availableMicro),
              earnedAllTimeUsd: microToDecimal(earnings.lifetimeMicro),
              canWithdrawNow: earnings.canWithdraw,
              minimumWithdrawUsd: microToDecimal(earnings.minWithdrawMicro),
              withdrawalInProgress: earnings.open ? { usd: microToDecimal(earnings.open.usdMicro), status: earnings.open.status } : null,
              note: "Withdrawals are paid as SKR, priced when the team sends them.",
            },
            providers: mine.map((p) => ({
              id: p.id,
              name: p.name,
              status: p.status === "submitted" ? "in review" : p.status === "verified" ? "live" : p.status,
              pricePerCallUsdc: Number(p.priceUsdc) > 0 ? p.priceUsdc : "free",
              uses: p.uses,
              featured: p.featured,
              // What the team asked the owner (the listing stays in review until they answer in "Notes for the Bluvfi team"), or why it was declined.
              hasOwnTerms: p.terms !== null,
              teamQuestion: p.status === "submitted" ? p.reviewNote ?? null : null,
              declinedBecause: p.status === "rejected" ? p.reviewNote ?? null : null,
              pausedBy: p.status === "paused" ? (p.pausedByOwner ? "the owner" : "the team") : null,
              // Only what kind of connection is set up and whether a key is saved. A key is never available to you or anyone.
              setup: {
                requestInputs: Array.isArray(p.inputFields) ? p.inputFields.length : 0,
                stepsBeforeUse: Array.isArray(p.requirements) ? p.requirements.length : 0,
                connection: p.auth.type === "none" ? "no key" : p.auth.type === "bearer" ? "bearer token" : "API-key header",
                keySaved: p.auth.hasSecret,
              },
              link: `bluvfi://provider/${p.id}`,
            })),
            openTheScreen: "bluvfi://network",
          };
        } catch (err) {
          return fail(err, "get_my_network_account");
        }
      },
    }),

    get_provider_details: tool({
      description:
        "One provider in the open network, in full: what it does, its price, the inputs a request needs (names, types, which are required), any steps " +
        "the user must do first (like creating an account) and where, and an example request. Use when the user asks how to use a provider, what it " +
        "needs, or whether they can use it right away. Get the id from search_network_providers or get_my_network_account.",
      inputSchema: z.object({ id: z.string().describe("The provider's id (a UUID)") }),
      execute: async ({ id }) => {
        if (!userId) return { error: "Not signed in." };
        if (!UUID.test(id)) return { error: "That isn't a provider id. Search for it first." };
        try {
          const p = await getProviderDetail(id, userId);
          if (!p) return { error: "That provider wasn't found. It may have been removed or paused." };
          const setup = setupFor(p);
          return {
            id: p.id,
            name: p.name,
            about: p.summary,
            category: p.category,
            pricePerCallUsdc: Number(p.priceUsdc) > 0 ? p.priceUsdc : "free",
            state: p.status === "verified" ? "live" : p.status === "submitted" ? "in review (only the owner can see it)" : p.status,
            yours: p.mine,
            owner: p.owner,
            uses: p.uses,
            featured: p.featured,
            docs: p.docsUrl,
            ...setup,
            // The owner's own terms (on top of Bluvfi's): people must agree to this exact version on the provider's page before they can use it.
            ownerTerms: p.terms ? { text: p.terms.text, link: p.terms.url, youHaveAgreed: p.mine ? "not needed: it is yours" : p.termsAcceptedAt !== null } : null,
            canUseRightAway: p.status === "verified" && setup.stepsBeforeUse.length === 0 && (!p.terms || p.mine || p.termsAcceptedAt !== null),
            exampleRequest: p.exampleRequest,
            link: `bluvfi://provider/${p.id}`,
          };
        } catch (err) {
          return fail(err, "get_provider_details");
        }
      },
    }),

    get_my_activity: tool({
      description:
        "The user's recent history, newest first: Shar they earned, claimed or spent, credits they added or used on providers, commission they earned, " +
        "and withdrawals, each with its state (done, pending, in review, on its way, declined). Use for 'what happened', 'where did my money go', " +
        "'did my claim go through', or 'what did I earn from my provider'. Optionally filter to shar, credits or commission.",
      inputSchema: z.object({
        source: z.enum(["all", "shar", "credits", "commission"]).optional(),
        limit: z.number().int().min(1).max(20).optional().describe("How many entries, default 10"),
      }),
      execute: async ({ source, limit }) => {
        if (!userId) return { error: "Not signed in." };
        try {
          const page = await getActivity(userId, { source: source ?? "all", limit: limit ?? 10 });
          return {
            entries: page.items.map((i) => ({
              what: i.title,
              detail: i.subtitle,
              amount: amountText(i.amount, i.unit),
              state: i.state === "done" ? "done" : i.state === "review" ? "in review" : i.state === "sending" ? "on its way" : i.state === "rejected" ? "declined" : "pending",
              when: i.at,
            })),
            hasMore: page.nextCursor !== null,
            partial: page.ready ? undefined : "Part of the history isn't available yet (still being set up).",
            openTheScreen: "bluvfi://activity",
          };
        } catch (err) {
          return fail(err, "get_my_activity");
        }
      },
    }),
  };
}
