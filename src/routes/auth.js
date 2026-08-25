import { withCompanyScope } from '../db/withCompanyScope.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  createSession,
  destroySession,
  serializeSessionCookie,
  clearSessionCookie,
  getSessionTokenFromRequest,
} from '../auth/sessions.js';
import { json, readJson } from '../lib/http.js';

const FAILED_LOGIN_LIMIT = 5;
const LOCKOUT_MS = 1000 * 60 * 15; // 15 minutes

// Signup always creates a brand-new company plus its first user, role
// owner, status active — this is the ONLY way a company gets created.
// A second person on an existing company never comes through here; see
// handleInvite (Phase 2 part 2) for that path.
export async function handleSignup(request, env) {
  const body = await readJson(request);
  if (!body || !body.email || !body.password || !body.companyName) {
    return json({ error: 'email, password, and companyName are required' }, { status: 400 });
  }

  const email = body.email.trim().toLowerCase();
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) {
    return json({ error: 'An account with that email already exists' }, { status: 409 });
  }

  const companyId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const now = Date.now();
  const passwordHash = await hashPassword(body.password);

  // companies has no company_id column — plain insert, not
  // withCompanyScope. See the comment in src/db/withCompanyScope.js.
  await env.DB
    .prepare('INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)')
    .bind(companyId, body.companyName, now)
    .run();

  const scope = withCompanyScope(env.DB, companyId);
  await scope.insert('users', {
    id: userId,
    email,
    password_hash: passwordHash,
    role: 'owner',
    status: 'active',
    created_at: now,
  });

  const { token, expiresAt } = await createSession(env.DB, { userId, companyId });
  const maxAgeSeconds = Math.floor((expiresAt - now) / 1000);

  return json(
    { user: { id: userId, email, role: 'owner' } },
    { status: 201, headers: { 'Set-Cookie': serializeSessionCookie(token, { maxAgeSeconds }) } }
  );
}

export async function handleLogin(request, env) {
  const body = await readJson(request);
  if (!body || !body.email || !body.password) {
    return json({ error: 'email and password are required' }, { status: 400 });
  }

  const email = body.email.trim().toLowerCase();
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();

  // Same generic error whether the email doesn't exist, the account
  // isn't active yet, or the password is wrong — never leak which one.
  const invalidCredentials = () => json({ error: 'Invalid email or password' }, { status: 401 });

  if (!user || user.status !== 'active' || !user.password_hash) {
    return invalidCredentials();
  }

  const now = Date.now();
  if (user.locked_until && user.locked_until > now) {
    return json({ error: 'Too many failed attempts. Try again later.' }, { status: 429 });
  }

  const validPassword = await verifyPassword(body.password, user.password_hash);
  if (!validPassword) {
    const failedCount = (user.failed_login_count || 0) + 1;
    const lockedUntil = failedCount >= FAILED_LOGIN_LIMIT ? now + LOCKOUT_MS : null;
    await env.DB
      .prepare('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?')
      .bind(failedCount, lockedUntil, user.id)
      .run();
    return invalidCredentials();
  }

  await env.DB
    .prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?')
    .bind(user.id)
    .run();

  const { token, expiresAt } = await createSession(env.DB, { userId: user.id, companyId: user.company_id });
  const maxAgeSeconds = Math.floor((expiresAt - now) / 1000);

  return json(
    { user: { id: user.id, email: user.email, role: user.role } },
    { status: 200, headers: { 'Set-Cookie': serializeSessionCookie(token, { maxAgeSeconds }) } }
  );
}

export async function handleLogout(request, env) {
  const token = getSessionTokenFromRequest(request);
  await destroySession(env.DB, token);
  return json({ ok: true }, { status: 200, headers: { 'Set-Cookie': clearSessionCookie() } });
}
