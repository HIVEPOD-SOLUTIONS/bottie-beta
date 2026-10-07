import https from "node:https";
import type { LookupFunction } from "node:net";

/**
 * One HTTPS POST to an address we have ALREADY checked.
 *
 * Why this exists: a provider is a URL someone else controls. The gateway checks that the host resolves only to public addresses,
 * then calls it. If the call did its own DNS lookup, the host could answer differently the second time (DNS rebinding) and point
 * the server at an internal address. Here the connection goes to exactly the address passed in, and no DNS lookup happens at all.
 *
 * The URL's hostname is still used for the TLS handshake (SNI) and for checking the certificate, so the connection is only
 * accepted if the machine at that address really presents a valid certificate for the provider's hostname.
 *
 * Also: no redirects are ever followed, the response is capped, the whole exchange has a deadline, and no connection is reused
 * (a reused socket could still be attached to a different address).
 */

export interface PinnedRequest {
  /** The provider's https URL. Its hostname is used for SNI and certificate checks, never for DNS. */
  url: URL;
  /** The IP address to connect to (already checked to be public). */
  address: string;
  family: 4 | 6;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  /** An extra trusted certificate authority. For tests only: production never sets it. */
  ca?: string;
}

export interface PinnedResponse {
  status: number;
  body: Buffer;
  /** The answer was longer than maxBytes: the body is cut off and must not be used. */
  truncated: boolean;
}

export function pinnedPost(req: PinnedRequest): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    // Whatever name the connection asks for, it gets the pinned address. (Node may ask for one address or for a list.)
    const lookup = ((_host: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
      if (options && options.all) callback(null, [{ address: req.address, family: req.family }]);
      else callback(null, req.address, req.family);
    }) as unknown as LookupFunction;

    const request = https.request(
      {
        method: "POST",
        hostname: req.url.hostname,
        port: req.url.port || 443,
        path: `${req.url.pathname}${req.url.search}`,
        headers: { ...req.headers, "Content-Length": String(Buffer.byteLength(req.body)) },
        lookup,
        servername: req.url.hostname,
        agent: false,
        ca: req.ca,
        signal: AbortSignal.timeout(req.timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const finish = () => done(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), truncated }));
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > req.maxBytes) {
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", finish);
        res.on("close", () => {
          if (truncated) finish();
          else done(() => reject(new Error("connection closed before the answer finished")));
        });
        res.on("error", (err) => {
          if (truncated) finish();
          else done(() => reject(err));
        });
      },
    );
    request.on("error", (err) => done(() => reject(err)));
    request.end(req.body);
  });
}
