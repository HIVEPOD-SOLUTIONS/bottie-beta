/**
 * The Solana RPC proxy behind POST /api/solana/rpc (src/lib/solana-rpc-proxy.ts and its route): who may call it, everything it
 * refuses to forward, and what a forwarded call looks like end to end (against a local fake upstream, so no key or network is
 * needed). The calls to a real provider only run when HELIUS_RPC_URL is set in the environment.
 *
 *     node scripts/tests/solana-rpc-proxy.test.cjs
 *     HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=..." node scripts/tests/solana-rpc-proxy.test.cjs   # adds live calls
 */
const http = require("http");
const nodeCrypto = require("crypto");
const { makeLoader, reporter, req } = require("./_harness.cjs");
const { check, finish } = reporter();
const web3 = req("@solana/web3.js");

class Res {
  constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.headers = init.headers ?? {}; }
  static json(data, init) { return new Res(JSON.stringify(data), init); }
}
// Offline runs use a placeholder upstream: refused calls never reach it, and the forwarding tests start their own fake one.
const state = { authOk: true, limitOk: true, env: process.env.HELIUS_RPC_URL ?? 'http://127.0.0.1:9/?api-key=offline' };
const load = makeLoader({
  "next/server": { NextResponse: Res, NextRequest: class {} },
  "@/lib/auth": { verifyAuth: async () => { if (!state.authOk) throw new Error("nope"); return { userId: "test-user" }; } },
  "@/lib/auth-response": { authErrorResponse: () => Res.json({ error: "Unauthorized" }, { status: 401 }) },
  "@/lib/server-env": { getServerEnv: () => state.env },
  "@/lib/user-rate-limiter": { checkApiLimit: async () => (state.limitOk ? { allowed: true, headers: {} } : { allowed: false, reason: "Too many requests. Please slow down.", headers: {} }) },
});
const proxy = load("src/lib/solana-rpc-proxy.ts");
const route = load("src/app/api/solana/rpc/route.ts");

const call = async (body, raw) => {
  const text = raw ?? JSON.stringify(body);
  const r = await route.POST({ text: async () => text });
  let parsed; try { parsed = JSON.parse(r.body); } catch { parsed = r.body; }
  return { status: r.status, body: parsed };
};
const K = 'GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4';
const ANS = proxy.ANS_PROGRAM;
const mc = (offset, bytes) => ({ memcmp: { offset, bytes, encoding: 'base58' } });

(async () => {
  // ── gatekeeping
  state.authOk = false;
  check('no auth -> 401', (await call({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [K] })).status === 401);
  state.authOk = true;
  const savedEnv = state.env; state.env = undefined;
  check('server key not set -> 501', (await call({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [K] })).status === 501);
  state.env = savedEnv;
  state.limitOk = false;
  check('rate limited -> 429', (await call({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [K] })).status === 429);
  state.limitOk = true;

  // ── things that must be refused (never reach upstream)
  const refuse = async (name, body, want = 400, raw) => {
    const r = await call(body, raw);
    check(`refused: ${name}`, r.status === want, `${r.status} ${JSON.stringify(r.body.error ?? r.body).slice(0, 60)}`);
  };
  await refuse('batch request', [{ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [K] }]);
  await refuse('sendTransaction', { jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: ['AAAA'] });
  await refuse('getBalance (not needed)', { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [K] });
  await refuse('getProgramAccounts on the Token program', { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', { encoding: 'base64', dataSlice: { offset: 0, length: 8 }, filters: [mc(8, K), mc(40, K)] }] });
  await refuse('getProgramAccounts without dataSlice', { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [ANS, { encoding: 'base64', filters: [mc(8, K), mc(40, K)] }] });
  await refuse('getProgramAccounts with a big dataSlice', { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [ANS, { encoding: 'base64', dataSlice: { offset: 0, length: 5000 }, filters: [mc(8, K), mc(40, K)] }] });
  await refuse('getProgramAccounts with one filter', { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [ANS, { encoding: 'base64', dataSlice: { offset: 104, length: 8 }, filters: [mc(8, K)] }] });
  await refuse('getProgramAccounts with no filters (full dump)', { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [ANS, { encoding: 'base64', dataSlice: { offset: 104, length: 8 } }] });
  await refuse('getProgramAccounts with a dataSize filter', { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [ANS, { encoding: 'base64', dataSlice: { offset: 104, length: 8 }, filters: [{ dataSize: 200 }, mc(8, K)] }] });
  await refuse('unexpected option key', { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [K, { encoding: 'base64', minContextSlot: 1 }] });
  await refuse('bad address', { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: ['not-an-address'] });
  await refuse('101 accounts', { jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [Array(101).fill(K)] });
  await refuse('token accounts for another program', { jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [K, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }] });
  await refuse('token accounts by mint', { jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [K, { mint: K }, { encoding: 'jsonParsed' }] });
  await refuse('invalid JSON', null, 400, '{not json');
  await refuse('oversized body', null, 413, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [K], pad: 'x'.repeat(9000) }));

  // ── forwarding, end to end, against a local fake upstream (no key, no network)
  const seen = [];
  const upstream = http.createServer((rq, rs) => {
    const parts = [];
    rq.on("data", (c) => parts.push(c));
    rq.on("end", () => {
      const sent = JSON.parse(Buffer.concat(parts).toString());
      seen.push({ url: rq.url, sent });
      rs.writeHead(200, { "Content-Type": "application/json" });
      rs.end(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { value: null, echoedMethod: sent.method } }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const savedEnv2 = state.env;
  state.env = `http://127.0.0.1:${upstream.address().port}/?api-key=SECRETKEY123`;
  const fwd = await call({ jsonrpc: "2.0", id: 77, method: "getAccountInfo", params: [K, { encoding: "base64" }] });
  check("forwarding: a valid call is passed upstream and its answer returned", fwd.status === 200 && fwd.body.result?.echoedMethod === "getAccountInfo", JSON.stringify(fwd.body).slice(0, 90));
  check("forwarding: the request id is echoed", fwd.body.id === 77);
  check("forwarding: the upstream URL and API key never appear in what the app receives", !JSON.stringify(fwd).includes("SECRETKEY123") && !JSON.stringify(fwd).includes("127.0.0.1"));
  check("forwarding: the upstream got the key (in its own URL) and only the validated request", seen[0] && seen[0].url.includes("SECRETKEY123") && seen[0].sent.method === "getAccountInfo");
  const before = seen.length;
  await call({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["AAAA"] });
  await call({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [ANS, { encoding: "base64" }] });
  check("forwarding: refused calls never reach the upstream", seen.length === before);
  upstream.close();
  state.env = savedEnv2;

  // ── real calls through to the upstream
  if (!process.env.HELIUS_RPC_URL) { console.log('SKIP  live calls: HELIUS_RPC_URL not set'); }
  else {
    // The same name-lookup the app does for a real .skr owner, end to end through the proxy.
    const hash = (s) => Uint8Array.from(nodeCrypto.createHash('sha256').update('ALT Name Service' + s, 'utf8').digest());
    const ZERO = new Uint8Array(32);
    const ANSK = new web3.PublicKey(ANS);
    const root = new web3.PublicKey('3mX9b4AZaQehNoQGfckVcmgmA6bkBoFcbLj9RMmMyNcU');
    const pda = (seeds) => web3.PublicKey.findProgramAddressSync(seeds, ANSK)[0];
    const parent = pda([hash('.skr'), ZERO, root.toBytes()]);
    const alice = pda([hash('alice'), ZERO, parent.toBytes()]);

    const info = await call({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [alice.toBase58(), { encoding: 'base64' }] });
    check('live getAccountInfo (alice.skr exists)', info.status === 200 && !!info.body.result?.value);
    const data = Buffer.from(info.body.result.value.data[0], 'base64');
    const owner = new web3.PublicKey(data.subarray(40, 72)).toBase58();

    const gpa = await call({ jsonrpc: '2.0', id: 2, method: 'getProgramAccounts', params: [ANS, { encoding: 'base64', dataSlice: { offset: 104, length: 8 }, filters: [mc(8, parent.toBase58()), mc(40, owner)] }] });
    check('live getProgramAccounts finds the owner\'s name account', gpa.status === 200 && Array.isArray(gpa.body.result) && gpa.body.result.some((a) => a.pubkey === alice.toBase58()), `${gpa.body.result?.length} account(s)`);

    const multi = await call({ jsonrpc: '2.0', id: 3, method: 'getMultipleAccounts', params: [[alice.toBase58(), K], { encoding: 'base64' }] });
    check('live getMultipleAccounts', multi.status === 200 && multi.body.result?.value?.length === 2);

    const tok = await call({ jsonrpc: '2.0', id: 4, method: 'getTokenAccountsByOwner', params: [K, { programId: proxy.TOKEN_2022_PROGRAM }, { encoding: 'jsonParsed' }] });
    check('live getTokenAccountsByOwner (Token-2022)', tok.status === 200 && Array.isArray(tok.body.result?.value));

    const hundred = await call({ jsonrpc: '2.0', id: 5, method: 'getMultipleAccounts', params: [Array(100).fill(K), { encoding: 'base64' }] });
    check('exactly 100 addresses is accepted', hundred.status === 200 && hundred.body.result?.value?.length === 100);
    check('request id is echoed', gpa.body.id === 2 && multi.body.id === 3);
    check('upstream URL / key never appears in a response', !JSON.stringify([info, gpa, multi, tok]).includes('api-key'));
  }
  finish();
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
