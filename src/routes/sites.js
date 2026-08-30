import { withCompanyScope } from '../db/withCompanyScope.js';
import { authenticate, requireRole } from '../auth/middleware.js';
import { json, readJson } from '../lib/http.js';
// Sites are company setup, not day-to-day inspection work — creating,
// editing, and deleting them is owner-only, same as the user/billing
// management the build prompt already scopes to 'owner'. Reading them
// (list/get) is open to any authenticated user, since a technician
// needs to see where they're going.
export async function handleCreateSite(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireRole(auth.user, 'owner')) {
    return json({ error: 'Only the account owner can manage sites' }, { status: 403 });
  }
  const body = await readJson(request);
  if (!body || !body.name || !body.name.trim()) {
    return json({ error: 'name is required' }, { status: 400 });
  }
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const id = crypto.randomUUID();
  await scope.insert('sites', {
    id,
    name: body.name.trim(),
    address: body.address ?? null,
    contact_name: body.contact_name ?? null,
    contact_email: body.contact_email ?? null,
    contact_phone: body.contact_phone ?? null,
    created_at: Date.now(),
  });
  const site = await scope.findById('sites', id);
  return json({ site }, { status: 201 });
}
export async function handleListSites(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const result = await scope.findAll('sites', 'name ASC');
  return json({ sites: result.results }, { status: 200 });
}
// Includes the site's assets in one extra query — this is a detail
// view, not the dashboard hot path, so a second query is fine here.
export async function handleGetSite(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const site = await scope.findById('sites', params.id);
  if (!site) return json({ error: 'Site not found' }, { status: 404 });
  const assets = await scope.all(
    'SELECT * FROM assets WHERE company_id = ? AND site_id = ? ORDER BY label ASC',
    [params.id]
  );
  return json({ site: { ...site, assets: assets.results } }, { status: 200 });
}
export async function handleUpdateSite(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireRole(auth.user, 'owner')) {
    return json({ error: 'Only the account owner can manage sites' }, { status: 403 });
  }
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const existing = await scope.findById('sites', params.id);
  if (!existing) return json({ error: 'Site not found' }, { status: 404 });
  const body = await readJson(request);
  if (!body) return json({ error: 'Request body is required' }, { status: 400 });
  const updates = {};
  if (body.name !== undefined) {
    if (!body.name.trim()) return json({ error: 'name cannot be empty' }, { status: 400 });
    updates.name = body.name.trim();
  }
  if (body.address !== undefined) updates.address = body.address;
  if (body.contact_name !== undefined) updates.contact_name = body.contact_name;
  if (body.contact_email !== undefined) updates.contact_email = body.contact_email;
  if (body.contact_phone !== undefined) updates.contact_phone = body.contact_phone;
  if (Object.keys(updates).length === 0) {
    return json({ error: 'No valid fields to update' }, { status: 400 });
  }
  await scope.update('sites', params.id, updates);
  const site = await scope.findById('sites', params.id);
  return json({ site }, { status: 200 });
}
export async function handleDeleteSite(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireRole(auth.user, 'owner')) {
    return json({ error: 'Only the account owner can manage sites' }, { status: 403 });
  }
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const existing = await scope.findById('sites', params.id);
  if (!existing) return json({ error: 'Site not found' }, { status: 404 });
  const stillHasAssets = await scope.first(
    'SELECT id FROM assets WHERE company_id = ? AND site_id = ? LIMIT 1',
    [params.id]
  );
  if (stillHasAssets) {
    return json({ error: "Remove this site's assets before deleting it" }, { status: 409 });
  }
  await scope.remove('sites', params.id);
  return json({ ok: true }, { status: 200 });
}
