// Deficiencies are auto-created at inspection submit (see
// inspections.js) for every failed checklist item — nothing here
// creates one directly. This file is just the office-facing view and
// the one allowed mutation: moving status forward.
import { withCompanyScope } from '../db/withCompanyScope.js';
import { authenticate } from '../auth/middleware.js';
import { json, readJson } from '../lib/http.js';

const VALID_STATUSES = ['open', 'quoted', 'resolved'];

// GET /api/deficiencies?status=open — any authenticated user can view;
// this is dashboard data, same access level as the dashboard itself.
export async function handleListDeficiencies(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });

  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const url = new URL(request.url);
  const status = url.searchParams.get('status');

  const result =
    status && VALID_STATUSES.includes(status)
      ? await scope.all(
          `SELECT d.*, a.label AS asset_label, a.asset_type, s.name AS site_name
           FROM deficiencies d
           JOIN assets a ON a.id = d.asset_id
           JOIN sites s ON s.id = a.site_id
           WHERE d.company_id = ? AND d.status = ?
           ORDER BY d.created_at DESC`,
          [status]
        )
      : await scope.all(
          `SELECT d.*, a.label AS asset_label, a.asset_type, s.name AS site_name
           FROM deficiencies d
           JOIN assets a ON a.id = d.asset_id
           JOIN sites s ON s.id = a.site_id
           WHERE d.company_id = ?
           ORDER BY d.created_at DESC`
        );

  return json({ deficiencies: result.results });
}

// PATCH /api/deficiencies/:id { status } — any authenticated user for
// now. Not owner-gated: a technician who fixes something on a return
// visit should be able to close it out same as office staff. Revisit
// if that turns out to be wrong in practice.
export async function handleUpdateDeficiency(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });

  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const existing = await scope.findById('deficiencies', params.id);
  if (!existing) return json({ error: 'Deficiency not found' }, { status: 404 });

  const body = await readJson(request);
  if (!body || !VALID_STATUSES.includes(body.status)) {
    return json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 });
  }

  const update = { status: body.status };
  if (body.status === 'resolved') update.resolved_at = Date.now();

  await scope.update('deficiencies', params.id, update);
  const updated = await scope.findById('deficiencies', params.id);
  return json({ deficiency: updated });
}
