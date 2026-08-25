import { generateRandomToken, sha256Hex } from '../lib/crypto-utils.js';

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const PASSWORD_RESET_TTL_MS = 1000 * 60 * 60; // 1 hour

export async function createAuthToken(db, { companyId, userId, type }) {
  const ttlMs = type === 'invite' ? INVITE_TTL_MS : PASSWORD_RESET_TTL_MS;
  const token = generateRandomToken();
  const tokenHash = await sha256Hex(token);
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + ttlMs;

  await db
    .prepare(
      'INSERT INTO auth_tokens (id, company_id, user_id, token_hash, type, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)'
    )
    .bind(id, companyId, userId, tokenHash, type, expiresAt, now)
    .run();

  return { token, expiresAt };
}

// Single-use: checks and marks-used in the same call. Returns the
// auth_tokens row (with user_id, company_id) or null if the token is
// missing, wrong type, already used, or expired.
export async function consumeAuthToken(db, token, type) {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ? AND type = ?').bind(tokenHash, type).first();

  if (!row) return null;
  if (row.used_at !== null) return null;
  if (row.expires_at < Date.now()) return null;

  await db.prepare('UPDATE auth_tokens SET used_at = ? WHERE id = ?').bind(Date.now(), row.id).run();

  return row;
}
