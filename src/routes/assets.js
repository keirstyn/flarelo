import { withCompanyScope } from '../db/withCompanyScope.js';
import { authenticate, requireRole } from '../auth/middleware.js';
import { json, readJson } from '../lib/http.js';

const DAY_MS = 1000 * 60 * 60 * 24;

// Fixed four-value enum by design — no custom-type builder, per the
// hard constraint in the build prompt. The DB's CHECK constraint would
// also reject anything else, but validating here gives a clean 400
// instead of a raw SQLite error surfacing to the client.
const ASSET_TYPES = ['fire_extinguisher', 'alarm_system', 'sprinkler_system', 'kitchen_suppression'];

// interval_days is set by the company, per asset, at their own
// discretion — never hardcode an NFPA/state-code default here or
// anywhere else. Same note as db/schema.sql; this is a deliberate
// liability boundary, not a missing feature.
//
// next_due_at on create: an explicit next_due_at wins (e.g. the
// company is importing an asset from its existing paper records and
// already knows when it's next due). Otherwise it's install_date (or
// "now", if no install_date given) plus one interval.
function computeNextDueAt(body, now) {
  if (body.next_due_at !== undefined && body.next_due_at !== null) {
    return Number(body.next_due_at);
  }
  const baseDate = body.install_date !== undefined && body.install_date !== null ? Number(body.install_date) : now;
  return baseDate + Number(body.interval_days) * DAY_MS;
}

// Same owner-only reasoning as sites.js — asset setup (type, interval)
// is company configuration, not the per-inspection work a technician
// does. Reading assets is open to any authenticated user.

export async function handleCreateAsset(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireRole(auth.user, 'owner')) {
    return json({ error: 'Only the account owner can manage assets' }, { status: 403 });
  }

  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const site = await scope.findById('sites', params.siteId);
  if (!site) return json({ error: 'Site not found' }, { status: 404 });

  const body = await readJson(request);
  if (!body || !body.label || !body.label.trim()) {
    return json({ error: 'label is required' }, { status: 400 });
  }
  if (!ASSET_TYPES.includes(body.asset_type)) {
    return json({ error: `asset_type must be one of: ${ASSET_TYPES.join(', ')}` }, { status: 400 });
  }
  const intervalDays = Number(body.interval_days);
  if (!Number.isInteger(intervalDays) || intervalDays <= 0) {
    return json({ error: 'interval_days must be a positive integer' }, { status: 400 });
  }

  const now = Date.now();
  const id = crypto.randomUUID();

  await scope.insert('assets', {
    id,
    site_id: params.siteId,
    asset_type: body.asset_type,
    label: body.label.trim(),
    install_date: body.install_date ?? null,
    interval_days: intervalDays,
    next_due_at: computeNextDueAt(body, now),
    last_inspected_at: null,
    created_at: now,
  });

  const asset = await scope.findById('assets', id);
  return json({ asset }, { status: 201 });
}

export async function handleListAssetsForSite(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });

  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const site = await scope.findById('sites', params.siteId);
  if (!site) return json({ error: 'Site not found' }, { status: 404 });

  const result = await scope.all(
    'SELECT * FROM assets WHERE company_id = ? AND site_id = ? ORDER BY label ASC',
    [params.siteId]
  );
  return json({ assets: result.results }, { status: 200 });
}

export async function handleGetAsset(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });

  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const asset = await scope.findById('assets', params.id);
  if (!asset) return json({ error: 'Asset not found' }, { status: 404 });
  return json({ asset }, { status: 200 });
}

export async function handleUpdateAsset(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireRole(auth.user, 'owner')) {
    return json({ error: 'Only the account owner can manage assets' }, { status: 403 });
  }

  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const existing = await scope.findById('assets', params.id);
  if (!existing) return json({ error: 'Asset not found' }, { status: 404 });

  const body = await readJson(request);
  if (!body) return json({ error: 'Request body is required' }, { status: 400 });

  const updates = {};
  if (body.label !== undefined) {
    if (!body.label.trim()) return json({ error: 'label cannot be empty' }, { status: 400 });
    updates.label = body.label.trim();
  }
  if (body.asset_type !== undefined) {
    if (!ASSET_TYPES.includes(body.asset_type)) {
      return json({ error: `asset_type must be one of: ${ASSET_TYPES.join(', ')}` }, { status: 400 });
    }
    updates.asset_type = body.asset_type;
  }
  if (body.install_date !== undefined) updates.install_date = body.install_date;
  if (body.interval_days !== undefined) {
    const intervalDays = Number(body.interval_days);
    if (!Number.isInteger(intervalDays) || intervalDays <= 0) {
      return json({ error: 'interval_days must be a positive integer' }, { status: 400 });
    }
    updates.interval_days = intervalDays;
  }
  // Lets the owner hand-correct a due date (e.g. importing a company's
  // existing paper records) independent of interval_days changing.
  if (body.next_due_at !== undefined) updates.next_due_at = Number(body.next_due_at);

  if (Object.keys(updates).length === 0) {
    return json({ error: 'No valid fields to update' }, { status: 400 });
  }

  await scope.update('assets', params.id, updates);
  const asset = await scope.findById('assets', params.id);
  return json({ asset }, { status: 200 });
}

export async function handleDeleteAsset(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireRole(auth.user, 'owner')) {
    return json({ error: 'Only the account owner can manage assets' }, { status: 403 });
  }

  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const existing = await scope.findById('assets', params.id);
  if (!existing) return json({ error: 'Asset not found' }, { status: 404 });

  // Same reasoning as site deletion: an asset with inspection history
  // shouldn't vanish as a side effect of cleanup. Inspections don't
  // exist yet (Phase 4), so this is always a no-op today — it's here
  // now so Phase 4 doesn't have to remember to come back and add it.
  const hasInspections = await scope.first(
    'SELECT id FROM inspections WHERE company_id = ? AND asset_id = ? LIMIT 1',
    [params.id]
  );
  if (hasInspections) {
    return json({ error: 'This asset has inspection history and cannot be deleted' }, { status: 409 });
  }

  await scope.remove('assets', params.id);
  return json({ ok: true }, { status: 200 });
}
