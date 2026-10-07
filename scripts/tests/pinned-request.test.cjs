/**
 * The pinned HTTPS transport the provider gateway uses (src/lib/pinned-request.ts), against a REAL local TLS server.
 * Proves the connection goes to exactly the address it was given with no DNS lookup, that the certificate is still checked
 * against the provider's hostname, and that redirects, oversized answers, slow answers and dropped connections are handled.
 *
 * Needs `openssl` on the PATH to make a throwaway certificate (skips cleanly without it).
 *
 *     node scripts/tests/pinned-request.test.cjs
 */
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { makeLoader, reporter } = require("./_harness.cjs");
const { check, finish } = reporter();

(async () => {
  // A self-signed certificate valid for provider.test only, made fresh for this run.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-"));
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "2", "-subj", "/CN=provider.test", "-addext", "subjectAltName=DNS:provider.test"], { stdio: "ignore" });
  } catch {
    console.log("SKIP  openssl isn't available here, so the TLS server can't be made");
    process.exit(0);
  }
  const key = fs.readFileSync(keyFile);
  const cert = fs.readFileSync(certFile, "utf8");

  let connections = 0;
  const server = https.createServer({ key, cert }, (req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const body = Buffer.concat(parts).toString();
      if (req.url === "/echo") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ host: req.headers.host, sni: req.socket.servername, method: req.method, body, length: req.headers["content-length"], custom: req.headers["x-test"] }));
      } else if (req.url === "/redirect") {
        res.writeHead(302, { Location: "https://169.254.169.254/latest/meta-data/" });
        res.end();
      } else if (req.url === "/big") {
        res.writeHead(200);
        res.write(Buffer.alloc(300_000, 65));
        res.end();
      } else if (req.url === "/slow") {
        res.writeHead(200);
        res.write("started");
        // never ends
      } else if (req.url === "/drop") {
        req.socket.destroy();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  server.on("secureConnection", () => connections++);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const { pinnedPost } = makeLoader({ "node:https": https })("src/lib/pinned-request.ts");
  const url = (host, p = "/echo") => new URL(`https://${host}:${port}${p}`);
  const req = (o = {}) => ({ url: url("provider.test"), address: "127.0.0.1", family: 4, body: '{"city":"Lagos"}', headers: { "Content-Type": "application/json", "X-Test": "yes" }, timeoutMs: 5000, maxBytes: 100_000, ca: cert, ...o });
  const fails = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

  // ── it goes to the address it was given, and never asks DNS
  const ok = await pinnedPost(req());
  const echoed = JSON.parse(ok.body.toString());
  check("connects to the pinned address although the hostname resolves nowhere (no DNS lookup is made)", ok.status === 200 && echoed.method === "POST");
  check("the Host header and TLS server name are the PROVIDER's hostname, not the IP", echoed.host === `provider.test:${port}` && echoed.sni === "provider.test", JSON.stringify(echoed));
  check("the JSON body, content-length and custom headers arrive intact", echoed.body === '{"city":"Lagos"}' && echoed.length === String(Buffer.byteLength('{"city":"Lagos"}')) && echoed.custom === "yes");
  check("an IPv4 answer is not truncated or flagged", ok.truncated === false);

  // ── the certificate is still checked against the hostname
  const wrongName = await fails(() => pinnedPost(req({ url: url("evil.test") })));
  check("the SAME server under a different hostname is refused (the certificate must match the provider's hostname)", wrongName && /altname|certificate|hostname/i.test(`${wrongName.code} ${wrongName.message}`), wrongName && wrongName.code);
  const untrusted = await fails(() => pinnedPost(req({ ca: undefined })));
  check("a certificate that isn't trusted is refused", untrusted && /SELF_SIGNED|UNABLE_TO_VERIFY|certificate/i.test(`${untrusted.code} ${untrusted.message}`), untrusted && untrusted.code);

  // ── no connection is reused (a reused socket could still point at an old address)
  const before = connections;
  await pinnedPost(req());
  await pinnedPost(req());
  check("every call opens its own connection (no keep-alive reuse)", connections === before + 2, `new connections: ${connections - before}`);

  // ── hostile or broken answers
  const redirect = await pinnedPost(req({ url: url("provider.test", "/redirect") }));
  check("a redirect is returned as-is and NEVER followed (it points at the cloud metadata address here)", redirect.status === 302 && redirect.body.length === 0);
  const t0 = Date.now();
  const big = await pinnedPost(req({ url: url("provider.test", "/big"), maxBytes: 1000 }));
  check("an oversized answer is cut off and flagged, not buffered", big.truncated === true && big.body.length <= 1000 && Date.now() - t0 < 4000, `body=${big.body.length}`);
  const t1 = Date.now();
  const slow = await fails(() => pinnedPost(req({ url: url("provider.test", "/slow"), timeoutMs: 600 })));
  check("an answer that never finishes is abandoned at the deadline", slow !== null && Date.now() - t1 < 3000, `${Date.now() - t1}ms`);
  const dropped = await fails(() => pinnedPost(req({ url: url("provider.test", "/drop") })));
  check("a dropped connection is an error, not a half answer", dropped !== null);
  const refused = await fails(() => pinnedPost(req({ address: "127.0.0.1", url: new URL("https://provider.test:1/echo") })));
  check("nothing listening at the pinned address is an error", refused !== null);
  const notFound = await pinnedPost(req({ url: url("provider.test", "/nope") }));
  check("a 404 is returned with its status", notFound.status === 404);

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  finish();
})().catch((e) => {
  process.stderr.write(`PINNED-REQUEST TEST CRASHED ${(e && e.stack) || e}\n`);
  process.exit(2);
});
