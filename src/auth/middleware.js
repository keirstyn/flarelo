import { validateSession, getSessionTokenFromRequest } from './sessions.js';

// Every non-public route calls this first. Returns { user, session } on
// a valid session for an active user, or null — callers turn null into
// a 401. There is no third state; a session for a not-yet-activated
// (status: invited) user is treated the same as no session at all.
export async function authenticate(request, env) {
  const token = getSessionTokenFromRequest(request);
  const session = await validateSession(env.DB, token);
  if (!session) return null;

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
  if (!user || user.status !== 'active') return null;

  return { user, session };
}

// owner: manages users, billing, and sites.
// technician: creates/edits their own inspections, views the
// dashboard; cannot remove users or touch billing.
// Every authenticated active user — regardless of role — satisfies a
// 'technician'-level check; only 'owner'-level checks actually
// restrict anything.
export function requireRole(user, role) {
  if (role === 'owner') return user.role === 'owner';
  return true;
}
