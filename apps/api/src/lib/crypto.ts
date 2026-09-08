import {
  createHmac,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scryptSync,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { config } from '../config.js';
import { stringify } from '../lib/json.js';

/**
 * Primitive security operations. Passwords use scrypt (memory-hard, no
 * native dependency); provider secrets and bank account numbers are encrypted
 * at rest with AES-256-GCM keyed from ENCRYPTION_KEY.
 *
 * Private keys for wallet custody never enter this process: deposit addresses
 * are derived/issued by the custody partner (see domain/blockchain.ts).
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(normalize(password), salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, n, r, p, salt, key] = stored.split('$');
  if (algo !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = scryptSync(normalize(password), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Pre-normalization reduces surprises from invisible unicode in passwords. */
function normalize(input: string): string {
  return input.normalize('NFKC');
}

function encryptionKey(): Buffer {
  return createHash('sha256').update(config.crypto.encryptionKey).digest();
}

export interface Encrypted {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export function encryptString(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const payload: Encrypted = {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
  return stringify(payload);
}

export function decryptString(blob: string | null | undefined): string | null {
  if (!blob) return null;
  try {
    const parsed = JSON.parse(blob) as Encrypted;
    if (parsed.v !== 1) return null;
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(parsed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Never leak decryption detail into logs/responses.
    return null;
  }
}

export function hmacSha256(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashToken(token: string): string {
  return sha256(token);
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

/** Last-4 style masking for bank accounts / tax ids stored encrypted. */
export function maskTail(value: string, keep = 4): string {
  if (value.length <= keep) return '•'.repeat(value.length);
  return `${'•'.repeat(Math.min(12, value.length - keep))}${value.slice(-keep)}`;
}

export function isProbablyJwt(token: string): boolean {
  return token.split('.').length === 3;
}
