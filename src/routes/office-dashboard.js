// Supplementary office-view endpoints — additive alongside the
// existing Phase 3 dashboard.js (not modified here; not reviewed this
// round, so left untouched rather than guessed at). Each of these is
// its own small indexed query rather than folded into one giant
// dashboard payload, matching the "obvious status at a glance" list
// from the product brief: overdue, deficiencies needing follow-up,
// recent activity.
import { withCompanyScope } from '../db/withCompanyScope.js';
import { authenticate } from '../auth/middleware.js';
import { json } from '../lib/http.js';

export async function handleOverdueAssets(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const result = await scope.all(
    `SELECT a.*, s.name AS site_name
     FROM assets a
     JOIN sites s ON s.id = a.site_id
     WHERE a.company_id = ? AND a.next_due_at < ?
     ORDER BY a.next_due_at ASC`,
    [Date.now()]
  );
  return json({ overdue: result.results });
}

export async function handleDeficiencySummary(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const result = await scope.all(
    `SELECT status, COUNT(*) AS count FROM deficiencies WHERE company_id = ? GROUP BY status`
  );
  const summary = { open: 0, quoted: 0, resolved: 0 };
  for (const row of result.results) summary[row.status] = row.count;
  return json({ summary });
}

export async function handleRecentInspections(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100);
  const result = await scope.all(
    `SELECT i.id, i.submitted_at, i.next_due_at_snapshot, a.label AS asset_label,
            a.asset_type, s.name AS site_name, u.email AS technician_email
     FROM inspections i
     JOIN assets a ON a.id = i.asset_id
     JOIN sites s ON s.id = a.site_id
     JOIN users u ON u.id = i.technician_user_id
     WHERE i.company_id = ?
     ORDER BY i.submitted_at DESC
     LIMIT ?`,
    [limit]
  );
  return json({ inspections: result.results });
}
