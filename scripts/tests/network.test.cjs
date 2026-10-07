/**
 * The open provider network: URL and IP safety, listing validation, review, usage caps, the gateway's protections and the admin
 * route's authorisation. The real src/lib code and routes on an in-memory Postgres; DNS, the pinned transport, auth and the rate limiter are
 * simulated (the transport itself is tested against a real TLS server in pinned-request.test.cjs).
 *
 *     node scripts/tests/network.test.cjs
 */
const { makeLoader, freshDb } = require('./_harness.cjs');

const env = { NETWORK_ADMIN_USER_IDS: 'ADMIN1, ADMIN2' };
const dnsState = { map: {}, calls: 0, sequence: null };
// A host's addresses; `sequence` lets a test make the SAME host answer differently on successive lookups (DNS rebinding).
const dnsStub = { promises: { lookup: async (host) => { dnsState.calls++; const a = dnsState.sequence ? dnsState.sequence.shift() : dnsState.map[host]; if (!a) throw new Error('ENOTFOUND'); return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })); } } };
// The pinned transport the gateway uses, replaced by a fake that records what it was asked to connect to.
const transport = { impl: async () => ({ status: 200, body: Buffer.from('{}'), truncated: false }) };
const auth = { user: 'U1', ok: true };
class Res { constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.headers = init.headers ?? {}; } static json(d, i) { return new Res(JSON.stringify(d), i); } }
const baseStubs = {
  'next/server': { NextResponse: Res, NextRequest: class {} },
  '@/lib/auth': { verifyAuth: async () => { if (!auth.ok) throw new Error('nope'); return { userId: auth.user }; } },
  '@/lib/auth-response': { authErrorResponse: () => Res.json({ error: 'Unauthorized' }, { status: 401 }) },
  '@/lib/user-rate-limiter': { checkApiLimit: async () => ({ allowed: true, headers: {} }) },
  '@/lib/server-env': { getServerEnv: (n) => env[n] },
  'node:dns': dnsStub,
  '@/lib/pinned-request': { pinnedPost: (req) => transport.impl(req) },
};
const pure = makeLoader(baseStubs);
const sharRules = pure('src/lib/shar-rules.ts');
const rules = pure('src/lib/provider-network-rules.ts');

async function fresh() {
  const { client, db } = await freshDb();
  const load = makeLoader({ ...baseStubs, '@/lib/db': { db } });
  return {
    client,
    net: load('src/lib/provider-network.ts'),
    shar: load('src/lib/shar.ts'),
    callRoute: load('src/app/api/network/providers/[id]/call/route.ts'),
    reviewRoute: load('src/app/api/network/providers/[id]/review/route.ts'),
  };
}

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  -> ' + extra : ''}`); };
const WALLET = '5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM';
const good = (o = {}) => ({ name: 'Weather Wisp', summary: 'Hyperlocal forecasts for travellers.', category: 'data', endpointUrl: 'https://api.example.com/v1/weather', priceUsdc: '0', payoutWallet: WALLET, ...o });

(async () => {
  // ── URL and IP safety
  const su = (u) => rules.safePublicUrl(u) !== null;
  check('url: public https accepted', su('https://api.example.com/v1?x=1'));
  for (const [label, u] of [['http', 'http://api.example.com'], ['IPv4 literal', 'https://8.8.8.8/'], ['loopback IP', 'https://127.0.0.1/'], ['IPv6 literal', 'https://[::1]/'], ['localhost', 'https://localhost/'], ['single-label host', 'https://intranet/'], ['credentials', 'https://u:p@api.example.com/'], ['custom port', 'https://api.example.com:8443/'], ['.internal', 'https://db.internal/'], ['.local', 'https://printer.local/'], ['unicode host', 'https://exаmple.com/'], ['not a url', 'hello'], ['javascript:', 'javascript:alert(1)'], ['too long', 'https://api.example.com/' + 'a'.repeat(300)]]) check(`url refused: ${label}`, !su(u));
  const pub = rules.isPublicIp;
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) check(`ip public: ${ip}`, pub(ip) === true);
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '256.1.1.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', 'ff02::1', '64:ff9b::a00:1', 'not-an-ip']) check(`ip blocked: ${ip}`, pub(ip) === false);

  // ── input validation
  const v = (o) => rules.validateListingInput(o);
  check('input: valid listing accepted and normalised', v(good({ name: '  Weather   Wisp ' })).ok && v(good({ name: '  Weather   Wisp ' })).value.name === 'Weather Wisp');
  for (const [label, o] of [['short name', { name: 'ab' }], ['control char in name', { name: 'Bad\u0007name' }], ['short summary', { summary: 'too short' }], ['bad category', { category: 'crypto-casino' }], ['http endpoint', { endpointUrl: 'http://api.example.com' }], ['private endpoint', { endpointUrl: 'https://10.0.0.5/' }], ['bad docs link', { docsUrl: 'ftp://x.com' }], ['price over cap', { priceUsdc: '6' }], ['exponent price', { priceUsdc: '1e3' }], ['negative price', { priceUsdc: '-1' }], ['bad wallet', { payoutWallet: 'hello' }], ['bad remix id', { remixOfId: 'nope' }]]) check(`input refused: ${label}`, v(good(o)).ok === false);
  check('input: array/null refused', !v([]).ok && !v(null).ok);
  check('input: price defaults to 0, max 5 allowed', v(good({ priceUsdc: undefined })).value.priceUsdc === '0' && v(good({ priceUsdc: '5' })).ok);

  // ── lifecycle on real Postgres
  const { client: c, net, callRoute, reviewRoute } = await fresh();
  const mk = async (user, o = {}) => { const r = await net.createListing(user, good(o)); if (!r.ok) throw new Error('create failed: ' + r.error); return r.listing; };
  const wisp = await mk('U1');
  check('create: starts as submitted with a slug', wisp.status === 'submitted' && /^weather-wisp-[a-z0-9]{3}$/.test(wisp.slug), wisp.slug);
  check('create: invalid input is refused with 400', (await net.createListing('U1', good({ name: 'x' }))).status === 400);
  check('create: remixing something not verified is refused', (await net.createListing('U2', good({ remixOfId: wisp.id }))).status === 404);
  check('review: unknown action 400', (await net.reviewListing(wisp.id, 'delete', null)).status === 400);
  check('review: unknown listing 404', (await net.reviewListing('99999999-9999-9999-9999-999999999999', 'verify', null)).status === 404);
  check('admin: only listed ids', net.isNetworkAdmin('ADMIN2') && net.isNetworkAdmin('ADMIN1') && !net.isNetworkAdmin('U1') && !net.isNetworkAdmin(''));
  check('list: unverified is not public', (await net.listVerified('U2')).length === 0);
  const mineBefore = await net.listMine('U1');
  check('mine: owner sees it with endpoint and status', mineBefore.length === 1 && mineBefore[0].status === 'submitted' && mineBefore[0].endpointUrl.startsWith('https://api.example.com'));
  check('review: verify works and stamps the time', (await net.reviewListing(wisp.id, 'verify', '  Looks good  ')).ok === true);
  const pubList = await net.listVerified('U2');
  check('list: verified is public, shows host not endpoint, anonymous owner', pubList.length === 1 && pubList[0].host === 'api.example.com' && !('endpointUrl' in pubList[0]) && /^Seeker [0-9A-F]{4}$/.test(pubList[0].owner) && pubList[0].mine === false);
  check('list: owner sees mine=true', (await net.listVerified('U1'))[0].mine === true);
  const remix = await net.createListing('U2', good({ name: 'Storm Wisp', remixOfId: wisp.id }));
  check('remix: allowed from a verified listing', remix.ok === true && remix.listing.remixOfId === wisp.id);
  await net.reviewListing(remix.listing.id, 'verify', null);
  const withRemix = (await net.listVerified('U3')).find((p) => p.id === wisp.id);
  check('remix: original shows 1 remix; the remix names its source', withRemix.remixes === 1 && (await net.listVerified('U3')).find((p) => p.id === remix.listing.id).remixOf.name === 'Weather Wisp');
  // limits
  for (let i = 0; i < 4; i++) await mk('U9', { name: `Provider ${i} ok` });
  await mk('U9', { name: 'Provider five' });
  check('limit: 6th submission in a day refused (429)', (await net.createListing('U9', good({ name: 'Provider six' }))).status === 429);

  // ── usage caps (SKR is at stake)
  const earn = async (caller) => (await net.recordUsage({ id: wisp.id, ownerUserId: 'U1' }, caller)).shar;
  check('usage: owner using own provider earns nothing', (await earn('U1')) === 0);
  const firstFive = []; for (let i = 0; i < 5; i++) firstFive.push(await earn('U5'));
  check('usage: a caller earns the owner Shar for their first 5 uses today', firstFive.every((s) => s === 1), firstFive.join(','));
  check('usage: the 6th use by the same caller earns nothing', (await earn('U5')) === 0);
  check('usage: a different caller still earns', (await earn('U6')) === 1);
  // owner daily cap: push the owner to the cap with many different callers
  await c.query(`insert into provider_usage (listing_id, caller_user_id, shar) select '${wisp.id}', 'bulk' || g, 1 from generate_series(1, 100) g`);
  check('usage: owner daily Shar cap stops further earning', (await earn('U7')) === 0);
  const sum = await require('node:util').promisify((cb) => cb(null))(); void sum;

  // ── gateway guards (DNS and the pinned transport stubbed)
  const call = async (id, body, user = 'U8') => { auth.user = user; const r = await callRoute.POST({ text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)) }, { params: Promise.resolve({ id }) }); return { status: r.status, body: JSON.parse(r.body) }; };
  const answer = (text, status = 200) => ({ status, body: Buffer.from(text), truncated: false });
  dnsState.map['api.example.com'] = ['93.184.216.34'];
  let fetched = [];
  transport.impl = async (req) => { fetched.push(req); return answer('{"forecast":"sunny"}'); };
  const usageCount = async () => (await c.query('select count(*)::int as n from provider_usage')).rows[0].n;
  let before = await usageCount();
  let r = await call(wisp.id, { city: 'Lagos' });
  check('gateway: verified free provider answers', r.status === 200 && r.body.data.forecast === 'sunny' && r.body.providerStatus === 200, JSON.stringify(r.body));
  check('gateway: the call is recorded as a use', (await usageCount()) === before + 1);
  check('gateway: forwards the JSON body and no user identity', !JSON.stringify(fetched[0].headers).includes('U8') && fetched[0].body === '{"city":"Lagos"}' && fetched[0].url.hostname === 'api.example.com');
  check('gateway: the connection is PINNED to the address that was checked', fetched[0].address === '93.184.216.34' && fetched[0].family === 4);
  check('gateway: unknown / bad id 404', (await call('99999999-9999-9999-9999-999999999999', {})).status === 404 && (await call('nope', {})).status === 404);
  const submitted = await mk('U4', { name: 'Draft provider' });
  check('gateway: unverified provider cannot be called (404)', (await call(submitted.id, {})).status === 404);
  const paid = await mk('U4', { name: 'Paid provider', priceUsdc: '0.25' }); await net.reviewListing(paid.id, 'verify', null);
  fetched = []; r = await call(paid.id, {});
  check('gateway: a paid provider with no credits is refused (402 insufficient_credits) and is NOT called', r.status === 402 && r.body.code === 'insufficient_credits' && fetched.length === 0);
  check('gateway: invalid JSON 400, oversize 413', (await call(wisp.id, '{bad')).status === 400 && (await call(wisp.id, { x: 'y'.repeat(9000) })).status === 413);

  // private / mixed DNS
  const evil = await mk('U4', { name: 'Evil rebinder', endpointUrl: 'https://evil.example.org/' }); await net.reviewListing(evil.id, 'verify', null);
  fetched = [];
  dnsState.map['evil.example.org'] = ['169.254.169.254'];
  r = await call(evil.id, {}); check('gateway: host resolving to cloud-metadata IP refused, no request made', r.status === 502 && fetched.length === 0);
  dnsState.map['evil.example.org'] = ['93.184.216.34', '10.0.0.7'];
  r = await call(evil.id, {}); check('gateway: ONE private address among several refuses the host', r.status === 502 && fetched.length === 0);
  delete dnsState.map['evil.example.org'];
  r = await call(evil.id, {}); check('gateway: host that does not resolve refused', r.status === 502 && fetched.length === 0);

  // hostile responses
  before = await usageCount();
  transport.impl = async () => answer('', 302);
  r = await call(wisp.id, {}); check('gateway: redirect refused and not counted as a use', r.status === 502 && (await usageCount()) === before);
  transport.impl = async () => ({ status: 200, body: Buffer.alloc(0), truncated: true });
  r = await call(wisp.id, {}); check('gateway: oversize response refused and not counted', r.status === 502 && (await usageCount()) === before);
  transport.impl = async () => { throw new Error('timeout'); };
  r = await call(wisp.id, {}); check('gateway: network failure -> 502 with a plain message', r.status === 502 && !JSON.stringify(r.body).includes('timeout'));
  transport.impl = async () => answer('{"error":"nope"}', 500);
  r = await call(wisp.id, {}); check('gateway: provider 500 is passed through but earns the owner nothing', r.body.providerStatus === 500 && (await usageCount()) === before);
  transport.impl = async () => answer('plain text answer');
  r = await call(wisp.id, {}, 'U10'); check('gateway: plain-text responses are returned as text', r.status === 200 && r.body.data === 'plain text answer');

  // ── DNS rebinding: the host is looked up ONCE per call and the connection goes to that exact address
  transport.impl = async (req) => { fetched.push(req); return answer('{"ok":true}'); };
  fetched = []; dnsState.calls = 0;
  r = await call(wisp.id, {}, 'U11');
  check('rebinding: exactly one DNS lookup per call', dnsState.calls === 1 && r.status === 200, 'lookups=' + dnsState.calls);
  // the host answers with a public address for the check and a private one afterwards: the second answer must never be used
  fetched = []; dnsState.calls = 0; dnsState.sequence = [['93.184.216.34'], ['169.254.169.254'], ['10.0.0.7']];
  r = await call(wisp.id, {}, 'U12');
  check('rebinding: a later private answer is never looked up, let alone connected to', r.status === 200 && dnsState.calls === 1 && fetched.length === 1 && fetched[0].address === '93.184.216.34', 'lookups=' + dnsState.calls);
  dnsState.sequence = null;
  // an IPv6 answer is pinned with the right family
  dnsState.map['v6.example.com'] = ['2606:4700:4700::1111'];
  const v6 = await mk('U4', { name: 'V6 provider', endpointUrl: 'https://v6.example.com/' }); await net.reviewListing(v6.id, 'verify', null);
  fetched = []; r = await call(v6.id, {}, 'U13');
  check('rebinding: an IPv6 provider is pinned to its IPv6 address (family 6)', r.status === 200 && fetched[0].address === '2606:4700:4700::1111' && fetched[0].family === 6);
  // a refused host never reaches the transport at all
  dnsState.map['v6.example.com'] = ['2606:4700:4700::1111', 'fd00::1'];
  fetched = []; r = await call(v6.id, {}, 'U14');
  check('rebinding: one private IPv6 address among the answers refuses the host', r.status === 502 && fetched.length === 0);

  // ── review route is admin-only
  const rv = async (user, body) => { auth.user = user; const r = await reviewRoute.POST({ json: async () => body }, { params: Promise.resolve({ id: submitted.id }) }); return { status: r.status, body: JSON.parse(r.body) }; };
  check('review route: a normal user gets 403', (await rv('U1', { action: 'verify' })).status === 403);
  check('review route: admin can verify', (await rv('ADMIN1', { action: 'verify', note: 'ok' })).status === 200);
  auth.ok = false; check('review route: signed out gets 401', (await rv('ADMIN1', { action: 'verify' })).status === 401); auth.ok = true;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
