import { bufferToHex, hexToBuffer, timingSafeEqualHex } from '../lib/crypto-utils.js';

// PBKDF2-HMAC-SHA256, not bcrypt/argon2 — Workers has no native
// bindings for either, and crypto.subtle's PBKDF2 support is built in.
//
// OWASP's current guidance for PBKDF2-HMAC-SHA256 is 600,000
// iterations. This uses 100,000 instead — a deliberate trade-off,
// not an oversight: Workers bills and limits by CPU time, and
// 600k iterations risks blowing through that budget on every single
// login. Revisit this number (up, ideally) once there's real
// production request-CPU-time data to tune it against.
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_LENGTH_BITS = 256;

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    KEY_LENGTH_BITS
  );

  const hashHex = bufferToHex(derivedBits);
  const saltHex = bufferToHex(salt.buffer);
  // scheme:iterations:salt:hash — iterations travels with the hash so
  // PBKDF2_ITERATIONS can change later without breaking verification
  // of passwords hashed under the old value.
  return `pbkdf2:${PBKDF2_ITERATIONS}:${saltHex}:${hashHex}`;
}

export async function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  const parts = storedHash.split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const [, iterationsStr, saltHex, hashHex] = parts;
  const iterations = parseInt(iterationsStr, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  const salt = hexToBuffer(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_LENGTH_BITS
  );

  const computedHex = bufferToHex(derivedBits);
  return timingSafeEqualHex(computedHex, hashHex);
}
