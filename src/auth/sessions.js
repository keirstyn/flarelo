import { generateRandomToken, sha256Hex } from '../lib/crypto-utils.js';

const SESSION_COOKIE_NAME = 'flarelo_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export async function createSession(db, { userId, companyId }) {
  const token = generateRandomToken();
  const tokenHash = await sha256Hex(token);
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await db
    .prepare(
      'INSERT INTO sessions (id, user_id, company_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(id, userId, companyId, tokenHash, expiresAt, now)
    .run();

  return { token, expiresAt };
}

// Returns the session row (with user_id, company_id) or null if the
// token is missing, unrecognized, or expired. Does NOT delete expired
// rows itself — that's routine cleanup, not this function's job.
export async function validateSession(db, token) {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const session = await db.prepare('SELECT * FROM sessions WHERE token_hash = ?').bind(tokenHash).first();
  if (!session) return null;
  if (session.expires_at < Date.now()) return null;
  return session;
}

export async function destroySession(db, token) {
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

export function serializeSessionCookie(token, { maxAgeSeconds }) {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function getSessionTokenFromRequest(request) {
  const cookieHeader = request.headers.get('Cookie') || '';
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE_NAME) return rest.join('=');
  }
  return null;
}
