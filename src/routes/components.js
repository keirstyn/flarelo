import { withCompanyScope } from '../db/withCompanyScope.js';
import { authenticate, requireRole } from '../auth/middleware.js';
import { json, readJson } from '../lib/http.js';

// Individual devices within a system-type asset (e.g. one smoke
// detector within an alarm_system). Same access pattern as
// sites/assets: write ops are owner-only, reads are open to any
// authenticated user. An asset with zero components behaves exactly
// as it always has — this is purely additive.
export async function handleCreateComponent(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireRole(auth.user, 'owner')) {
    return json({ error: 'Only the account owner can manage components' }, { status: 403 });
  }
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const asset = await scope.findById('assets', params.assetId);
  if (!asset) return json({ error: 'Asset not found' }, { status: 404 });
  const body = await readJson(request);
  if (!body || !body.component_type || !body.component_type.trim()) {
    return json({ error: 'component_type is required' }, { status: 400 });
  }
  if (!body.label || !body.label.trim()) {
    return json({ error: 'label is required' }, { status: 400 });
  }
  const id = crypto.randomUUID();
  await scope.insert('asset_components', {
    id,
    asset_id: params.assetId,
    component_type: body.component_type.trim(),
    label: body.label.trim(),
    location_note: body.location_note ?? null,
    created_at: Date.now(),
  });
  const component = await scope.findById('asset_components', id);
  return json({ component }, { status: 201 });
}

export async function handleListComponents(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const asset = await scope.findById('assets', params.assetId);
  if (!asset) return json({ error: 'Asset not found' }, { status: 404 });
  const result = await scope.all(
    'SELECT * FROM asset_components WHERE company_id = ? AND asset_id = ? ORDER BY label ASC',
    [params.assetId]
  );
  return json({ components: result.results }, { status: 200 });
}

export async function handleDeleteComponent(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireRole(auth.user, 'owner')) {
    return json({ error: 'Only the account owner can manage components' }, { status: 403 });
  }
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const existing = await scope.findById('asset_components', params.id);
  if (!existing) return json({ error: 'Component not found' }, { status: 404 });
  const hasResults = await scope.first(
    'SELECT id FROM inspection_component_results WHERE company_id = ? AND asset_component_id = ? LIMIT 1',
    [params.id]
  );
  if (hasResults) {
    return json({ error: 'This component has inspection history and cannot be deleted' }, { status: 409 });
  }
  await scope.remove('asset_components', params.id);
  return json({ ok: true }, { status: 200 });
}
