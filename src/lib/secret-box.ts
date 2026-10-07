import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getServerEnv } from "@/lib/server-env";

/**
 * Encrypts a provider owner's API key before it is stored, and decrypts it only at the moment a call to their endpoint is made.
 * AES-256-GCM with a random nonce per value. The `aad` (the listing id) is authenticated with the ciphertext, so a stored value
 * copied onto another listing's row won't decrypt.
 *
 * The key comes from PROVIDER_SECRET_KEY: 32 random bytes as 64 hex characters or base64. If it isn't set, nothing is stored:
 * there is deliberately no plaintext fallback.
 *
 * Losing or changing the key makes every saved credential unreadable (owners then have to enter their keys again).
 */

function loadKey(): Buffer | null {
  const raw = getServerEnv("PROVIDER_SECRET_KEY");
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

/** Whether credentials can be saved on this server. */
export const secretsEnabled = (): boolean => loadKey() !== null;

export function encryptSecret(plain: string, aad: string): string {
  const key = loadKey();
  if (!key) throw new Error("PROVIDER_SECRET_KEY is not set");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

/** The original text, or null when it can't be read (wrong key, wrong listing, or tampered with). Never throws. */
export function decryptSecret(stored: string, aad: string): string | null {
  try {
    const key = loadKey();
    const [v, iv, tag, ct] = stored.split(".");
    if (!key || v !== "v1" || !iv || !tag || !ct) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
