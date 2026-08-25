import { withCompanyScope } from '../db/withCompanyScope.js';
import { authenticate } from '../auth/middleware.js';
import { json } from '../lib/http.js';

const DAY_MS = 1000 * 60 * 60 * 24;
const DEFAULT_WINDOW_DAYS = 30;

// "Assets due within 30 days, grouped by site" — the screen the
// customer opens every morning. One indexed query on
// (company_id, next_due_at) — see idx_assets_company_next_due in
// db/schema.sql — then grouped by site in JS, not SQL, so the query
// stays a single simple range scan.
//
// "Due within N days" includes anything already overdue (next_due_at
// in the past), not just the upcoming window — that's what a company
// needs surfaced first, not hidden because the window technically
// already closed.
export async function handleDashboard(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const daysParam = url.searchParams.get('days');
  const days = daysParam !== null ? Number(daysParam) : DEFAULT_WINDOW_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    return json({ error: 'days must be a positive number' }, { status: 400 });
  }

  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const threshold = Date.now() + days * DAY_MS;

  const result = await scope.all(
    `SELECT assets.*, sites.name AS site_name
     FROM assets
     JOIN sites ON sites.id = assets.site_id AND sites.company_id = assets.company_id
     WHERE assets.company_id = ? AND assets.next_due_at <= ?
     ORDER BY assets.next_due_at ASC`,
    [threshold]
  );

  const bySite = new Map();
  for (const row of result.results) {
    const { site_name, ...asset } = row;
    if (!bySite.has(asset.site_id)) {
      bySite.set(asset.site_id, { site_id: asset.site_id, site_name, assets: [] });
    }
    bySite.get(asset.site_id).assets.push(asset);
  }

  return json({ window_days: days, sites: [...bySite.values()] }, { status: 200 });
}
