import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import schemaSql from '../db/schema.sql?raw';
import { withCompanyScope } from '../src/db/withCompanyScope.js';
import { createSession, serializeSessionCookie } from '../src/auth/sessions.js';

function parseStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

beforeAll(async () => {
  const statements = parseStatements(schemaSql);
  await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
});

describe('health check', () => {
  it('responds on /health', async () => {
    const res = await SELF.fetch('https://example.com/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});

// Cross-account isolation harness — the project's stand-in for
// Postgres RLS (D1 has none). Seeds two companies, each with one
// owner, gives company B a site and an asset, then hits every
// company-A-authenticated endpoint that takes an id with one of
// company B's ids. Every one of those calls must come back 403/404 —
// never 500, and never a 200 carrying company B's data.
describe('cross-account isolation', () => {
  it("returns 403/404 (never 500, never real data) when company A's user touches company B's sites/assets", async () => {
    const now = Date.now();

    await env.DB.prepare('INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)')
      .bind('iso-company-a', 'Iso A Co', now)
      .run();
    await env.DB.prepare('INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)')
      .bind('iso-company-b', 'Iso B Co', now)
      .run();

    const scopeA = withCompanyScope(env.DB, 'iso-company-a');
    const scopeB = withCompanyScope(env.DB, 'iso-company-b');

    await scopeA.insert('users', {
      id: 'iso-user-a',
      email: 'iso-a@example.com',
      password_hash: null,
      role: 'owner',
      status: 'active',
      created_at: now,
    });
    await scopeB.insert('users', {
      id: 'iso-user-b',
      email: 'iso-b@example.com',
      password_hash: null,
      role: 'owner',
      status: 'active',
      created_at: now,
    });

    await scopeB.insert('sites', { id: 'iso-site-b', name: 'B Site', created_at: now });
    await scopeB.insert('assets', {
      id: 'iso-asset-b',
      site_id: 'iso-site-b',
      asset_type: 'fire_extinguisher',
      label: 'B Extinguisher',
      interval_days: 365,
      next_due_at: now + 1000,
      created_at: now,
    });

    const { token } = await createSession(env.DB, { userId: 'iso-user-a', companyId: 'iso-company-a' });
    const cookie = serializeSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0];
    const authedGet = (path) => SELF.fetch(`https://example.com${path}`, { headers: { Cookie: cookie } });
    const authedWrite = (path, method, body) =>
      SELF.fetch(`https://example.com${path}`, {
        method,
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

    const getSite = await authedGet('/api/sites/iso-site-b');
    expect(getSite.status).toBe(404);

    const getAsset = await authedGet('/api/assets/iso-asset-b');
    expect(getAsset.status).toBe(404);

    const listAssetsForBSite = await authedGet('/api/sites/iso-site-b/assets');
    expect(listAssetsForBSite.status).toBe(404);

    const updateSite = await authedWrite('/api/sites/iso-site-b', 'PATCH', { name: 'Hijacked' });
    expect([403, 404]).toContain(updateSite.status);

    const deleteSite = await authedWrite('/api/sites/iso-site-b', 'DELETE');
    expect([403, 404]).toContain(deleteSite.status);

    const deleteAsset = await authedWrite('/api/assets/iso-asset-b', 'DELETE');
    expect([403, 404]).toContain(deleteAsset.status);

    const createAssetUnderBSite = await authedWrite('/api/sites/iso-site-b/assets', 'POST', {
      label: 'Sneaked in',
      asset_type: 'fire_extinguisher',
      interval_days: 365,
    });
    expect([403, 404]).toContain(createAssetUnderBSite.status);

    // Company A's own dashboard must never surface company B's assets.
    const dashboard = await authedGet('/api/dashboard?days=36500');
    expect(dashboard.status).toBe(200);
    const dashboardBody = await dashboard.json();
    expect(dashboardBody.sites.some((s) => s.site_id === 'iso-site-b')).toBe(false);
  });

  it("returns 403/404 (never 500, never real data) when company A's user touches company B's inspections", async () => {
    const now = Date.now();
    const scopeB = withCompanyScope(env.DB, 'iso-company-b');
    await scopeB.insert('inspections', {
      id: 'iso-inspection-b',
      asset_id: 'iso-asset-b',
      technician_user_id: 'iso-user-b',
      checklist_json: '[]',
      pdf_r2_key: 'reports/iso-company-b/fake.pdf',
      next_due_at_snapshot: now,
      submitted_at: now,
    });

    const { token } = await createSession(env.DB, { userId: 'iso-user-a', companyId: 'iso-company-a' });
    const cookie = serializeSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0];

    const submitRes = await SELF.fetch('https://example.com/api/assets/iso-asset-b/inspections', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [], signature: 'ZmFrZQ==' }),
    });
    expect(submitRes.status).toBe(404);

    const pdfRes = await SELF.fetch('https://example.com/api/inspections/iso-inspection-b/pdf', {
      headers: { Cookie: cookie },
    });
    expect(pdfRes.status).toBe(404);
  });
});
