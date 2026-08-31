import { withCompanyScope } from '../db/withCompanyScope.js';
import { authenticate, requireRole } from '../auth/middleware.js';
import { json, readJson } from '../lib/http.js';

const ASSET_TYPES = ['fire_extinguisher', 'alarm_system', 'sprinkler_system', 'kitchen_suppression'];

// Configurable checklist content — the intended eventual replacement
// for the hardcoded CHECKLISTS object in src/lib/checklists.js.
// Owner-only to create/edit, same reasoning as sites/assets: company
// setup, not day-to-day inspection work.
//
// This stores whatever content is submitted as-is. It does not
// validate, generate, or imply any regulatory correctness — checklist
// authorship is a human decision for a qualified professional, not
// something this code assumes or checks.
export async function handleCreateChecklistTemplate(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireRole(auth.user, 'owner')) {
    return json({ error: 'Only the account owner can manage checklist templates' }, { status: 403 });
  }
  const body = await readJson(request);
  if (!body || !ASSET_TYPES.includes(body.asset_type)) {
    return json({ error: `asset_type must be one of: ${ASSET_TYPES.join(', ')}` }, { status: 400 });
  }
  if (!body.name || !body.name.trim()) {
    return json({ error: 'name is required' }, { status: 400 });
  }
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const id = crypto.randomUUID();
  await scope.insert('checklist_templates', {
    id,
    asset_type: body.asset_type,
    name: body.name.trim(),
    frequency_label: body.frequency_label ?? null,
    is_active: 1,
    created_at: Date.now(),
  });
  const template = await scope.findById('checklist_templates', id);
  return json({ template }, { status: 201 });
}

export async function handleListChecklistTemplates(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const url = new URL(request.url);
  const assetType = url.searchParams.get('asset_type');
  const result =
    assetType && ASSET_TYPES.includes(assetType)
      ? await scope.all(
          'SELECT * FROM checklist_templates WHERE company_id = ? AND asset_type = ? AND is_active = 1 ORDER BY name ASC',
          [assetType]
        )
      : await scope.all(
          'SELECT * FROM checklist_templates WHERE company_id = ? AND is_active = 1 ORDER BY asset_type ASC, name ASC'
        );
  return json({ templates: result.results }, { status: 200 });
}

export async function handleGetChecklistTemplate(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const template = await scope.findById('checklist_templates', params.id);
  if (!template) return json({ error: 'Checklist template not found' }, { status: 404 });
  const items = await scope.all(
    'SELECT * FROM checklist_template_items WHERE company_id = ? AND checklist_template_id = ? ORDER BY sort_order ASC',
    [params.id]
  );
  return json({ template: { ...template, items: items.results } }, { status: 200 });
}

export async function handleDeactivateChecklistTemplate(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireRole(auth.user, 'owner')) {
    return json({ error: 'Only the account owner can manage checklist templates' }, { status: 403 });
  }
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const existing = await scope.findById('checklist_templates', params.id);
  if (!existing) return json({ error: 'Checklist template not found' }, { status: 404 });
  await scope.update('checklist_templates', params.id, { is_active: 0 });
  return json({ ok: true }, { status: 200 });
}

export async function handleAddChecklistTemplateItem(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireRole(auth.user, 'owner')) {
    return json({ error: 'Only the account owner can manage checklist templates' }, { status: 403 });
  }
  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const template = await scope.findById('checklist_templates', params.id);
  if (!template) return json({ error: 'Checklist template not found' }, { status: 404 });
  const body = await readJson(request);
  if (!body || !body.item_key || !body.item_key.trim()) {
    return json({ error: 'item_key is required' }, { status: 400 });
  }
  if (!body.label || !body.label.trim()) {
    return json({ error: 'label is required' }, { status: 400 });
  }
  if (!['system', 'component'].includes(body.applies_to)) {
    return json({ error: "applies_to must be 'system' or 'component'" }, { status: 400 });
  }
  if (body.applies_to === 'component' && (!body.component_type || !body.component_type.trim())) {
    return json({ error: 'component_type is required when applies_to is "component"' }, { status: 400 });
  }
  const id = crypto.randomUUID();
  await scope.insert('checklist_template_items', {
    id,
    checklist_template_id: params.id,
    item_key: body.item_key.trim(),
    label: body.label.trim(),
    applies_to: body.applies_to,
    component_type: body.applies_to === 'component' ? body.component_type.trim() : null,
    sort_order: Number.isInteger(body.sort_order) ? body.sort_order : 0,
    created_at: Date.now(),
  });
  const item = await scope.findById('checklist_template_items', id);
  return json({ item }, { status: 201 });
}
