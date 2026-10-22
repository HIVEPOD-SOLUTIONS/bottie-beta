/**
 * A rewarded ad helps a user who ran out of daily AI capacity (the LLM-token budget), not only one who ran out of messages:
 * every bonus message also gives back tokens, bounded by the same grant cap. The real src/lib/user-rate-limiter.ts over an
 * in-memory stand-in for the rate-limit store.
 *
 *     node scripts/tests/ad-bonus-tokens.test.cjs
 */
const { makeLoader, reporter } = require("./_harness.cjs");
const { check, finish } = reporter();

// A tiny in-memory rate_limits table with the same behaviour as src/lib/rate-limit-store.ts.
const buckets = new Map();
const live = (key) => {
  const b = buckets.get(key);
  return b && b.resetAt > Date.now() ? b : null;
};
const store = {
  hit: async (key, windowMs, max, amount = 1) => {
    let b = live(key);
    if (!b) {
      b = { count: 0, resetAt: Date.now() + windowMs };
      buckets.set(key, b);
    }
    if (b.count + amount > max) return { allowed: false, count: b.count, resetAt: b.resetAt };
    b.count += amount;
    return { allowed: true, count: b.count, resetAt: b.resetAt };
  },
  peek: async (key) => {
    const b = live(key);
    return b ? { count: b.count, resetAt: b.resetAt } : null;
  },
  credit: async (key, amount) => {
    const b = live(key);
    if (b) b.count = Math.max(0, b.count - amount);
  },
  takeAll: async (key) => {
    const b = live(key);
    if (!b) return 0;
    const n = b.count;
    buckets.delete(key);
    return n;
  },
};

const lim = makeLoader({ "@/lib/rate-limit-store": store })("src/lib/user-rate-limiter.ts");
const U = "did:privy:ad-user";

(async () => {
  const BUDGET = 1_000_000;
  // The user burns the whole free token budget.
  await store.hit(`chattokens:daily:${U}`, 86_400_000, 2_000_000_000, BUDGET);
  const blocked = await lim.checkChatTokenBudget(U, false);
  check("out of AI capacity: the request is refused", blocked.allowed === false);
  check("...and the message offers an ad (free users)", /watch an ad/i.test(blocked.reason) && /AI capacity/.test(blocked.reason), blocked.reason);
  const premium = await lim.checkChatTokenBudget(U, true);
  check("a premium user is not blocked by the free budget", premium.allowed === true);

  const granted = await lim.grantChatBonus(U, 5);
  check("an ad grants its messages", granted === 5);
  const used = (await store.peek(`chattokens:daily:${U}`)).count;
  check("...and gives tokens back (5 messages x the per-message amount)", used === BUDGET - 5 * lim.BONUS_TOKENS_PER_MESSAGE, String(used));
  const after = await lim.checkChatTokenBudget(U, false);
  check("a big enough bonus gets the user chatting again", (await lim.grantChatBonus(U, 10)) > 0 && (await lim.checkChatTokenBudget(U, false)).allowed === true);

  // Bounded: at most 6 grants of 10 messages a day, so the extra capacity has a ceiling.
  const V = "did:privy:ad-farmer";
  await store.hit(`chattokens:daily:${V}`, 86_400_000, 2_000_000_000, 5_000_000);
  let total = 0;
  for (let i = 0; i < 20; i++) total += await lim.grantChatBonus(V, 10);
  const left = (await store.peek(`chattokens:daily:${V}`)).count;
  check("ads are capped per day (6 grants), so the bonus is bounded", total === 60, String(total));
  check("...and the token credit is bounded the same way (60 messages' worth)", left === 5_000_000 - 60 * lim.BONUS_TOKENS_PER_MESSAGE, String(left));

  // A bonus never pushes the counter below zero, and does nothing for a user with no live window.
  const W = "did:privy:ad-new";
  await lim.grantChatBonus(W, 10);
  check("a bonus for a user with nothing used creates no negative balance", (await store.peek(`chattokens:daily:${W}`)) === null);

  finish();
})();
