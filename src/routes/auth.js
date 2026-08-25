import { withCompanyScope } from '../db/withCompanyScope.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  createSession,
  destroySession,
  serializeSessionCookie,
  clearSessionCookie,
  getSessionTokenFromRequest,
} from '../auth/sessions.js';
import { createAuthToken, consumeAuthToken } from '../auth/tokens.js';
import { authenticate, requireRole } from '../auth/middleware.js';
import { sendEmail } from '../lib/email.js';
import { json, readJson } from '../lib/http.js';

const FAILED_LOGIN_LIMIT = 5;
const LOCKOUT_MS = 1000 * 60 * 15; // 15 minutes
const PASSWORD_RESET_RATE_LIMIT_MS = 1000 * 60 * 5; // 5 minutes

// Signup always creates a brand-new company plus its first user, role
// owner, status active — this is the ONLY way a company gets created.
// A second person on an existing company never comes through here; see
// handleInvite below for that path.
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

// Owner-only: invite a teammate by email. Creates a `users` row with
// status 'invited' scoped to the owner's own company_id, and emails a
// signed, expiring link for them to set their password and activate.
//
// The third parameter doubles as the Workers ExecutionContext when
// called through the router, and as a test-only overrides object
// (e.g. { sendEmailFn: fakeSendEmail }) when called directly in tests
// — see test/auth-invite-reset.test.js. A real ExecutionContext has no
// sendEmailFn property, so the default applies exactly as normal in
// production; this only changes behavior when a test explicitly
// supplies one.
export async function handleInvite(request, env, { sendEmailFn = sendEmail } = {}) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireRole(auth.user, 'owner')) {
    return json({ error: 'Only the account owner can invite teammates' }, { status: 403 });
  }

  const body = await readJson(request);
  if (!body || !body.email) {
    return json({ error: 'email is required' }, { status: 400 });
  }

  const email = body.email.trim().toLowerCase();
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) {
    return json({ error: 'An account with that email already exists' }, { status: 409 });
  }

  // Defaults to technician unless the owner explicitly invites another owner.
  const role = body.role === 'owner' ? 'owner' : 'technician';
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const userId = crypto.randomUUID();
  await scope.insert('users', {
    id: userId,
    email,
    password_hash: null,
    role,
    status: 'invited',
    created_at: Date.now(),
  });

  const { token } = await createAuthToken(env.DB, {
    companyId: auth.user.company_id,
    userId,
    type: 'invite',
  });

  const inviteUrl = `${new URL(request.url).origin}/accept-invite?token=${token}`;
  await sendEmailFn(env, {
    to: email,
    subject: "You've been invited to Flarelo",
    body: `You've been invited to join a company on Flarelo. Set your password here: ${inviteUrl}\n\nThis link expires in 7 days.`,
  });

  return json({ ok: true }, { status: 201 });
}

// Public: accept an invite by setting a password. Consuming the token
// flips the invited user's status to active and logs them in.
export async function handleAcceptInvite(request, env) {
  const body = await readJson(request);
  if (!body || !body.token || !body.password) {
    return json({ error: 'token and password are required' }, { status: 400 });
  }

  const authToken = await consumeAuthToken(env.DB, body.token, 'invite');
  if (!authToken) {
    return json({ error: 'This invite link is invalid or has expired' }, { status: 400 });
  }

  const passwordHash = await hashPassword(body.password);
  await env.DB
    .prepare("UPDATE users SET password_hash = ?, status = 'active' WHERE id = ?")
    .bind(passwordHash, authToken.user_id)
    .run();

  const { token, expiresAt } = await createSession(env.DB, {
    userId: authToken.user_id,
    companyId: authToken.company_id,
  });
  const maxAgeSeconds = Math.floor((expiresAt - Date.now()) / 1000);

  return json(
    { ok: true },
    { status: 200, headers: { 'Set-Cookie': serializeSessionCookie(token, { maxAgeSeconds }) } }
  );
}

// Public: request a password reset. Always returns 200 whether or not
// the email exists, and sends at most one email per
// PASSWORD_RESET_RATE_LIMIT_MS per account — so this endpoint can't be
// used to enumerate accounts or to spam someone's inbox.
//
// Third parameter: see the comment on handleInvite above.
export async function handleRequestPasswordReset(request, env, { sendEmailFn = sendEmail } = {}) {
  const body = await readJson(request);
  if (!body || !body.email) {
    return json({ error: 'email is required' }, { status: 400 });
  }

  const email = body.email.trim().toLowerCase();
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ? AND status = 'active'").bind(email).first();

  if (user) {
    const recentToken = await env.DB
      .prepare(
        "SELECT id FROM auth_tokens WHERE user_id = ? AND type = 'password_reset' AND used_at IS NULL AND created_at > ?"
      )
      .bind(user.id, Date.now() - PASSWORD_RESET_RATE_LIMIT_MS)
      .first();

    if (!recentToken) {
      const { token } = await createAuthToken(env.DB, {
        companyId: user.company_id,
        userId: user.id,
        type: 'password_reset',
      });
      const resetUrl = `${new URL(request.url).origin}/reset-password?token=${token}`;
      await sendEmailFn(env, {
        to: email,
        subject: 'Reset your Flarelo password',
        body: `Reset your password here: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`,
      });
    }
  }

  return json({ ok: true }, { status: 200 });
}

export async function handleResetPassword(request, env) {
  const body = await readJson(request);
  if (!body || !body.token || !body.password) {
    return json({ error: 'token and password are required' }, { status: 400 });
  }

  const authToken = await consumeAuthToken(env.DB, body.token, 'password_reset');
  if (!authToken) {
    return json({ error: 'This reset link is invalid or has expired' }, { status: 400 });
  }

  const passwordHash = await hashPassword(body.password);
  await env.DB
    .prepare('UPDATE users SET password_hash = ?, failed_login_count = 0, locked_until = NULL WHERE id = ?')
    .bind(passwordHash, authToken.user_id)
    .run();

  return json({ ok: true }, { status: 200 });
}
