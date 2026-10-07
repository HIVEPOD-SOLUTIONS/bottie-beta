/**
 * A test backend for trying the Android app (emulator or phone) without touching production, Neon or any real money.
 *
 * It serves the REAL route handlers for Shar, the provider network (add, edit, pause, search, call), credits, commission,
 * x402-free paid calls, admin review and SKR payouts, on an in-memory Postgres built from the real migrations, with a SIMULATED
 * chain behind payouts and the signed-in user fixed as an admin (E2E_USER). Demo data is seeded on start. Any other request
 * is forwarded to https://www.bluvfi.xyz. Providers' own servers are faked: they answer and echo the request they were sent.
 *
 *     PGLITE_PATH=<folder with @electric-sql/pglite> node scripts/e2e/server.cjs        (PORT=3100 by default)
 *     EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:3100 npx expo start --dev-client --port 8082    # from the app repo
 *
 * Test-only controls while it runs (GET):
 *     /__topup?usd=5        add credits to the signed-in user      /__earn?usd=5     add commission
 *     /__price?usd=0.0176   set the simulated SKR price            /__state          claim and payout states
 *     /__chain?mode=ok|throw_after_landing|throw_before_landing|drop&confirm=confirmed|failed|timeout&height=N
 * Never point this at real keys: the treasury and the chain here are simulations.
 */
const http = require('http');
const path = require('path');
const WEB = path.resolve(__dirname, '../..') + '/';
const { makeLoader, freshDb } = require(WEB + 'scripts/tests/_harness.cjs');
const { fakeChain } = require(WEB + 'scripts/tests/_fakechain.cjs');

const PROD = 'https://www.bluvfi.xyz';
const ME = 'E2E_USER';
const WALLET = '5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM';
class Res { constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.headers = init.headers ?? {}; } static json(d, i) { return new Res(JSON.stringify(d), i); } }
const env = { NETWORK_ADMIN_USER_IDS: process.env.E2E_NOT_ADMIN === '1' ? 'someone-else' : ME, CREDITS_DEPOSIT_ADDRESS: 'BLuvF1DepositAddress11111111111111111111111', PROVIDER_SECRET_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff' }; // a throwaway key, for the emulator only

(async () => {
  const { client, db } = await freshDb();
  const chain = fakeChain();
  const base = {
    'next/server': { NextResponse: Res, NextRequest: class {} },
    '@/lib/auth': { verifyAuth: async () => ({ userId: ME }), getUserWalletAddresses: async () => ({ evm: [], solana: [] }) },
    '@/lib/auth-response': { authErrorResponse: () => Res.json({ error: 'Unauthorized' }, { status: 401 }) },
    '@/lib/user-rate-limiter': { checkApiLimit: async () => ({ allowed: true, headers: {} }) },
    '@/lib/server-env': { getServerEnv: (n) => env[n] },
    'node:dns': { promises: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] } },
    '@/lib/db': { db },
    '@/lib/pinned-request': {
      pinnedPost: async (req) => {
        let echo = null;
        try { echo = req.body ? JSON.parse(req.body) : null; } catch { echo = String(req.body); }
        const names = Object.keys(req.headers).map((h) => h.toLowerCase());
        const keyHeader = names.find((h) => h === 'x-api-key' || h === 'authorization');
        const answer = { ok: true, provider: req.url.hostname, rate: '1 USD = 1,540 NGN', youSent: echo, credentialReceived: keyHeader ? `yes (${keyHeader})` : 'no' };
        return { status: 200, body: Buffer.from(JSON.stringify(answer)), truncated: false };
      },
    },
  };
  const realPayout = makeLoader(base)('src/lib/skr-payout.ts');
  const payoutStub = { ...realPayout, getRealChain: async () => chain, payPayout: (i) => realPayout.payPayout(i, chain), quotePayout: (k, id) => realPayout.quotePayout(k, id, chain), reconcilePayout: (k, id) => realPayout.reconcilePayout(k, id, chain) };
  const load = makeLoader({ ...base, '@/lib/skr-payout': payoutStub });
  const R = (f) => load(`src/app/api/${f}/route.ts`);
  const routes = {
    '/api/shar': R('shar'), '/api/shar/leaderboard': R('shar/leaderboard'), '/api/shar/claim': R('shar/claim'), '/api/shar/referral': R('shar/referral'),
    '/api/creator': R('creator'), '/api/network/providers': R('network/providers'), '/api/credits': R('credits'), '/api/credits/topup': R('credits/topup'),
    '/api/activity/feed': R('activity/feed'), '/api/earnings': R('earnings'), '/api/earnings/withdraw': R('earnings/withdraw'), '/api/admin/me': R('admin/me'), '/api/admin/queue': R('admin/queue'),
  };
  const callRoute = R('network/providers/[id]/call');
  const termsRoute = R('network/providers/[id]/terms');
  const reviewRoute = R('network/providers/[id]/review');
  const detailRoute = R('network/providers/[id]');
  const payoutRoute = R('admin/payouts/[kind]/[id]');
  const shar = load('src/lib/shar.ts');
  const net = load('src/lib/provider-network.ts');
  const credits = load('src/lib/credits.ts');
  const earnings = load('src/lib/earnings.ts');

  // ── demo data
  const d = (days, hours = 0) => new Date(Date.now() - days * 86400000 - hours * 3600000).toISOString().replace('T', ' ').replace('Z', '');
  const pay = (u, type, status, amt, desc, when) => client.query('insert into payments (user_id,type,status,amount_usdc,description,created_at) values ($1,$2,$3,$4,$5,$6)', [u, type, status, amt, desc, when]);
  await pay(ME, 'bill', 'completed', '1500', 'Steam gift card', d(1));
  for (const [u, amt] of [['U_A', '420'], ['U_B', '310'], ['U_C', '205']]) await pay(u, 'bill', 'completed', amt, 'Gift card', d(1));
  const mk = async (owner, name, o) => { const r = await net.createListing(owner, { name, summary: o.summary, category: o.category, endpointUrl: o.endpoint, priceUsdc: o.price ?? '0', payoutWallet: WALLET, exampleRequest: o.example }, o.publisher, o.config, o.terms); if (!r.ok) throw new Error(r.error); if (o.verify !== false) await net.reviewListing(r.listing.id, 'verify', null); return r.listing; };
  // Weather Wisp's owner is a signed-up creator; the demo user (ME) is NOT, so the sign-up can be tried.
  await net.enrollCreator('U_A', { operatorType: 'company', companyName: 'Weather Wisp Ltd', companyWebsite: 'https://weather.example.com/', contactEmail: 'team@weather.example.com', termsAccepted: true, termsVersion: '2026-10-07' });
  await mk('U_A', 'Weather Wisp', { summary: 'Hyperlocal forecasts for travellers, tuned for West Africa.', category: 'data', endpoint: 'https://api.example.com/weather', example: { city: 'Lagos', days: 3 },
    publisher: { operatorType: 'company', companyName: 'Weather Wisp Ltd', companyWebsite: 'https://weather.example.com/', contactEmail: 'team@weather.example.com', termsVersion: '2026-10-07' },
    config: {
      inputFields: [
        { key: 'city', label: 'City', type: 'text', required: true, help: 'The city to get the forecast for', placeholder: 'Lagos', choices: null, default: null },
        { key: 'days', label: 'Days', type: 'number', required: false, help: 'How many days ahead (1-7)', placeholder: '3', choices: null, default: 3 },
        { key: 'units', label: 'Units', type: 'choice', required: false, help: null, placeholder: null, choices: ['metric', 'imperial'], default: null },
        { key: 'alerts', label: 'Weather alerts', type: 'boolean', required: false, help: 'Include severe-weather alerts', placeholder: null, choices: null, default: null },
      ],
      requirements: ['Create a free account at weather.example.com', 'Copy your region code from the dashboard'],
      setupUrl: 'https://weather.example.com/signup',
      teamNotes: 'Please allowlist 203.0.113.7. A test key was emailed to the team.',
      auth: { type: 'header', header: 'X-API-Key', secret: 'demo-key-1234' },
    },
    terms: { text: 'For lawful use only. Do not resell the forecasts. Do not store answers for longer than 24 hours.', url: 'https://weather.example.com/terms' } });
  await mk('U_B', 'Gas Guardian', { summary: 'Warns you when network fees spike, before you pay too much.', category: 'defi', endpoint: 'https://gas.example.net/v1' });
  await mk('U_B', 'KYC Lite', { summary: 'Light identity checks for small onboarding flows.', category: 'identity', endpoint: 'https://kyc.example.org/check', price: '0.03', example: { name: 'Ada Obi', country: 'NG' } });
  const old = await mk(ME, 'Old Wisp', { summary: 'An older provider the owner paused while fixing it.', category: 'other', endpoint: 'https://old.example.com/api' });
  await net.ownerAction(ME, old.id, 'pause');
  const oracle = await mk('U_C', 'Price Oracle', { summary: 'Signed spot prices for 500 tokens, billed per call.', category: 'defi', endpoint: 'https://oracle.example.net/v1', price: '0.05', example: { token: 'SOL' } });
  await net.reviewListing(oracle.id, 'feature', null);
  const mine = await mk(ME, 'Naira Rate Watch', { summary: 'Live NGN to USD rates from three exchanges.', category: 'payments', endpoint: 'https://rates.example.com/ngn', price: '0.10', example: { pair: 'NGN/USD' },
    publisher: { operatorType: 'individual', companyName: null, companyWebsite: null, contactEmail: 'owner@example.com', termsVersion: '2026-10-07' },
    config: { inputFields: null, requirements: null, setupUrl: null, teamNotes: 'Paid API, key is the demo one.', auth: { type: 'bearer', header: 'Authorization', secret: 'demo-bearer-5678' } } });
  await mk(ME, 'Pidgin Translate', { summary: 'Translate English to Nigerian Pidgin and back.', category: 'ai', endpoint: 'https://pidgin.example.com/api', verify: false });
  await mk('U_D', 'Storm Alerts', { summary: 'Severe-weather alerts in plain language, pushed to your phone.', category: 'ai', endpoint: 'https://storms.example.org/v2', price: '0.02', verify: false }); // waiting for admin review
  // paid calls by others earned ME commission: 40 calls at $0.10 -> $3.20 for ME
  for (let i = 0; i < 40; i++) await client.query(`insert into provider_usage (listing_id, caller_user_id, shar, paid_micro, owner_micro, platform_micro) values ($1, $2, 0, 100000, 80000, 20000)`, [mine.id, 'caller' + (i % 9)]);
  await client.query(`insert into earnings_balances (user_id, available_micro, lifetime_micro) values ($1, 3200000, 3200000)`, [ME]);
  // credits history for ME, so the Activity screen has top-ups and charges to show
  await credits.creditTopup(ME, 'demo-topup-1', 5_000_000);
  await credits.debitForCall(ME, oracle.id, 50_000);
  await credits.debitForCall(ME, oracle.id, 50_000);
  // payouts waiting for the admin
  await pay('U_E', 'bill', 'completed', '3000', 'Gift card', d(2));
  const claim = await shar.createClaim('U_E', { shar: 1000, wallet: WALLET });
  await client.query(`insert into earnings_balances (user_id, available_micro, lifetime_micro) values ('U_F', 9000000, 9000000)`);
  await earnings.requestWithdrawal('U_F', 'DKL92bJrYVWKLsmmw8NDGjSsEc5Xc8LzJbP1JEnDVSoF'.slice(0, 44));
  console.log('demo data ready; claim', claim.ok);

  // the providers' own servers are faked
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (/^https:\/\/[^/]*example\.(com|org|net)\//.test(u)) {
      let echo = null;
      try { echo = init && init.body ? JSON.parse(init.body) : null; } catch { echo = String(init && init.body); }
      const bytes = new TextEncoder().encode(JSON.stringify({ ok: true, provider: new URL(u).hostname, rate: '1 USD = 1,540 NGN', youSent: echo }));
      let sent = false;
      return { status: 200, body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })), cancel: async () => {} }) } };
    }
    return realFetch(url, init);
  };

  const readBody = (req) => new Promise((resolve) => { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => resolve(Buffer.concat(parts))); });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const raw = await readBody(req);
    const log = (note) => console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${url.pathname} ${note}`);
    try {
      // test-only controls
      if (url.pathname === '/__topup') { const usd = Number(url.searchParams.get('usd') || '5'); const r = await credits.creditTopup(ME, 'sig-' + Date.now(), Math.round(usd * 1e6)); log('topup ' + usd); res.writeHead(200); res.end(JSON.stringify(r)); return; }
      if (url.pathname === '/__earn') { const usd = Number(url.searchParams.get('usd') || '5'); await client.query(`update earnings_balances set available_micro = available_micro + $2, lifetime_micro = lifetime_micro + $2 where user_id = $1`, [ME, Math.round(usd * 1e6)]); log('earned ' + usd); res.writeHead(200); res.end('{"ok":true}'); return; }
      if (url.pathname === '/__price') { const p = Number(url.searchParams.get('usd') || '0.0176'); chain.state.quote = (usd) => ({ skrMicro: Math.round(usd / p), priceImpactPct: 0.01 }); log('SKR price ' + p); res.writeHead(200); res.end('{"ok":true}'); return; }
      if (url.pathname === '/__chain') { const m = url.searchParams.get('mode'); if (m) chain.state.sendMode = m; const c = url.searchParams.get('confirm'); if (c) chain.state.confirmMode = c; const h = url.searchParams.get('height'); if (h) chain.state.height += Number(h); res.writeHead(200); res.end(JSON.stringify({ sendMode: chain.state.sendMode, confirmMode: chain.state.confirmMode, height: chain.state.height, sent: chain.state.sent.length, landed: chain.state.landed.size })); return; }
      if (url.pathname === '/__state') { const rows = (await client.query(`select 'claim' k, status, count(*)::int n from shar_claims group by status union all select 'commission', status, count(*)::int from commission_payouts group by status`)).rows; res.writeHead(200); res.end(JSON.stringify({ rows, sent: chain.state.sent.length })); return; }

      let handler = routes[url.pathname], params;
      const det = url.pathname.match(/^\/api\/network\/providers\/([0-9a-f-]{36})$/);
      if (det) { handler = detailRoute; params = { id: det[1] }; }
      const call = url.pathname.match(/^\/api\/network\/providers\/([^/]+)\/call$/);
      const terms = url.pathname.match(/^\/api\/network\/providers\/([^/]+)\/terms$/);
      const rev = url.pathname.match(/^\/api\/network\/providers\/([^/]+)\/review$/);
      const po = url.pathname.match(/^\/api\/admin\/payouts\/([^/]+)\/([^/]+)$/);
      if (call) { handler = callRoute; params = { id: call[1] }; }
      else if (terms) { handler = termsRoute; params = { id: terms[1] }; }
      if (rev) { handler = reviewRoute; params = { id: rev[1] }; }
      if (po) { handler = payoutRoute; params = { kind: po[1], id: po[2] }; }
      const fn = handler && handler[req.method];
      if (fn) {
        const request = { json: async () => JSON.parse(raw.toString() || '{}'), text: async () => raw.toString(), nextUrl: url };
        const r = await fn(request, params ? { params: Promise.resolve(params) } : undefined);
        log(`-> ${r.status} (local)`);
        res.writeHead(r.status, { 'Content-Type': 'application/json', ...r.headers }); res.end(r.body);
        return;
      }
      const headers = { ...req.headers }; delete headers.host; delete headers['content-length']; delete headers.connection;
      const up = await realFetch(PROD + url.pathname + url.search, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw });
      const buf = Buffer.from(await up.arrayBuffer());
      const out = {}; up.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(k)) out[k] = v; });
      log(`-> ${up.status} (prod)`);
      res.writeHead(up.status, out); res.end(buf);
    } catch (e) {
      log(`ERROR ${e.stack || e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'test server error: ' + e.message }));
    }
  });
  const PORT = Number(process.env.PORT || 3100);
  server.listen(PORT, '0.0.0.0', () => console.log('Test backend on :' + PORT));
})().catch((e) => { console.error('E2E2 SETUP FAILED', e); process.exit(1); });
