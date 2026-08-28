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

// owner: manages users, billing, and everything else.
// office: everything technician can do, plus site/asset management
// and deficiency follow-up — the "runs the day-to-day" role, but no
// billing or user management. Added Phase 4 to support a dedicated
// office/admin person at growing companies, distinct from a
// field technician and from the owner.
// technician: creates/edits their own inspections, views the
// dashboard; cannot manage sites/assets/users/billing.
//
// requireRole(user, minimumRole) is a MINIMUM rank check, not
// equality — 'office' passes for office or owner, 'technician' passes
// for anyone authenticated. An unrecognized minimumRole now fails
// closed (denies) rather than the old code's implicit fail-open for
// any string that wasn't exactly 'owner' — this only matters if a
// future call site passes a typo'd role, but failing closed there is
// the safer default.
const ROLE_RANK = { technician: 0, office: 1, owner: 2 };

export function requireRole(user, minimumRole) {
  const userRank = ROLE_RANK[user.role] ?? -1;
  const requiredRank = ROLE_RANK[minimumRole] ?? Infinity;
  return userRank >= requiredRank;
}
