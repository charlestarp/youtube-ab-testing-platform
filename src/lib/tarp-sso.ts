/**
 * tarp-sso.ts — fleet SSO cookie verifier (consumer side) for YT Testing.
 *
 * Verifies ONLY this app's signature slot in the parent-domain `tarp_sso` cookie
 * issued by TARPGPT, using this app's independent key. Proves an email identity;
 * never creates or authorises a local account.
 *
 * Security contract (see TARPGPT docs/SSO-AND-LAUNCHER.md):
 *   - fails closed, never throws on bad input;
 *   - key is 64 lowercase hex chars decoded to 32 raw bytes;
 *   - MAC input is the exact ASCII string `<APP_ID>.<payloadBase64url>`;
 *   - absent secret => disabled; present-but-malformed secret => startup error.
 */
import crypto from 'crypto';

const APP_ID = 'testing';
const MAX_COOKIE_BYTES = 4096;
const MAX_LIFETIME_SECONDS = 7 * 24 * 60 * 60; // 604800

function loadKey(): Buffer | null {
  const hex = (process.env.TARP_SSO_SECRET || '').trim();
  if (!hex) return null; // SSO disabled for this process.
  if (hex.length !== 64 || hex !== hex.toLowerCase() || !/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('TARP_SSO_SECRET must be 64 lowercase hex characters');
  }
  return Buffer.from(hex, 'hex'); // 32 bytes
}

const KEY: Buffer | null = loadKey();

export function tarpSsoEnabled(): boolean {
  return KEY !== null;
}

export type TarpSsoClaims = { email: string; exp: number };

/** Verify the raw `tarp_sso` cookie value. Returns { email, exp } or null. Never throws. */
export function verifyTarpSso(raw: string | undefined | null): TarpSsoClaims | null {
  try {
    if (!KEY || !raw || raw.length > MAX_COOKIE_BYTES) return null;

    const parts = raw.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [payloadB64, sigB64] = parts;

    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const signatures = JSON.parse(Buffer.from(sigB64, 'base64url').toString('utf8'));
    if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null;
    if (typeof signatures !== 'object' || signatures === null || Array.isArray(signatures)) return null;

    if (claims.v !== 1) return null;
    if (claims.iss !== 'tarpgpt.com') return null;
    if (typeof claims.sub !== 'string') return null;
    if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) return null;

    const sub: string = claims.sub;
    if (sub !== sub.trim().toLowerCase() || !sub.includes('@') || sub.length > 254) return null;

    const now = Math.floor(Date.now() / 1000);
    if (claims.iat > now + 60) return null;
    if (claims.exp <= now) return null;
    if (claims.exp <= claims.iat) return null;
    if (claims.exp - claims.iat > MAX_LIFETIME_SECONDS + 60) return null;

    const sig = signatures[APP_ID];
    if (typeof sig !== 'string' || !sig) return null;
    const sigBytes = Buffer.from(sig, 'base64url');
    if (sigBytes.length !== 32) return null;

    const expected = crypto.createHmac('sha256', KEY)
      .update(`${APP_ID}.${payloadB64}`)
      .digest();
    if (!crypto.timingSafeEqual(sigBytes, expected)) return null;

    return { email: sub, exp: claims.exp };
  } catch {
    return null;
  }
}

/** Format a Unix-seconds instant into this app's stored ISO timestamp form. */
export function expToISO(expSeconds: number): string {
  return new Date(expSeconds * 1000).toISOString();
}
