import { createHmac, randomBytes, createHash } from 'node:crypto';

/**
 * RFC 6238 TOTP for 2FA. Implemented locally so the sandbox works without an
 * external auth service; production may additionally accept passkeys
 * (WebAuthn) — see `docs/SECURITY.md`, where the credential ceremony is
 * intentionally left to the platform's identity provider or a WebAuthn lib
 * once a relying-party domain is configured.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_SECONDS = 30;
const DIGITS = 6;

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secretBase32: string, at: Date = new Date(), windowStep = 0): string {
  const counter = Math.floor(at.getTime() / 1000 / PERIOD_SECONDS) + windowStep;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    (((digest[offset]! & 0x7f) << 24) |
      ((digest[offset + 1]! & 0xff) << 16) |
      ((digest[offset + 2]! & 0xff) << 8) |
      (digest[offset + 3]! & 0xff)) %
    10 ** DIGITS;
  return code.toString().padStart(DIGITS, '0');
}

/** ±1 step skew tolerance (90s) — the standard usability trade-off. */
export function verifyTotp(secretBase32: string, code: string, at: Date = new Date()): boolean {
  const normalized = code.replace(/\D/g, '');
  if (normalized.length !== DIGITS) return false;
  for (const step of [-1, 0, 1]) {
    if (totpCode(secretBase32, at, step) === normalized) return true;
  }
  return false;
}

export function totpUri(secretBase32: string, email: string, issuer = 'AuraPay'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD_SECONDS}`;
}

/** Recovery codes: single-use, stored hashed, shown exactly once at enrolment. */
export function generateRecoveryCodes(count = 8): { plain: string[]; hashed: string[] } {
  const plain = Array.from({ length: count }, () => `${randomBytes(3).toString('hex')}-${randomBytes(3).toString('hex')}`);
  return { plain, hashed: plain.map((code) => sha256Hex(code)) };
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
