import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import schemaSql from '../db/schema.sql?raw';
import { withCompanyScope } from '../src/db/withCompanyScope.js';
import { createSession, serializeSessionCookie } from '../src/auth/sessions.js';

const DAY_MS = 1000 * 60 * 60 * 24;

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

async function signupOwner(overrides = {}) {
  const res = await SELF.fetch('https://example.com/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      email: `owner-${crypto.randomUUID()}@sites.test`,
      password: 'ownerpassword1',
      companyName: 'Sites Co',
      ...overrides,
    }),
  });
  const cookie = res.headers.get('Set-Cookie').split(';')[0];
  const body = await res.json();
  return { cookie, companyId: undefined, userId: body.user.id };
}

// Bypasses the invite/email flow (already covered in
// test/auth-invite-reset.test.js) — creates an already-active
// technician directly, scoped to the given company, and hands back a
// ready-to-use session cookie.
async function createTechnicianSession(companyId, email) {
  const scope = withCompanyScope(env.DB, companyId);
  const id = crypto.randomUUID();
  await scope.insert('users', {
    id,
    email,
    password_hash: null,
    role: 'technician',
    status: 'active',
    created_at: Date.now(),
  });
  const { token } = await createSession(env.DB, { userId: id, companyId });
  return serializeSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0];
}

function authedFetch(cookie, path, { method = 'GET', body } = {}) {
  return SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('sites', () => {
  it('an owner can create, list, get, update, and delete a site', async () => {
    const { cookie } = await signupOwner();

    const createRes = await authedFetch(cookie, '/api/sites', {
      method: 'POST',
      body: { name: 'Main St Diner', address: '123 Main St' },
    });
    expect(createRes.status).toBe(201);
    const { site } = await createRes.json();
    expect(site.name).toBe('Main St Diner');

    const listRes = await authedFetch(cookie, '/api/sites');
    const { sites } = await listRes.json();
    expect(sites.some((s) => s.id === site.id)).toBe(true);

    const getRes = await authedFetch(cookie, `/api/sites/${site.id}`);
    const getBody = await getRes.json();
    expect(getBody.site.id).toBe(site.id);
    expect(getBody.site.assets).toEqual([]);

    const updateRes = await authedFetch(cookie, `/api/sites/${site.id}`, {
      method: 'PATCH',
      body: { name: 'Renamed Diner' },
    });
    expect(updateRes.status).toBe(200);
    expect((await updateRes.json()).site.name).toBe('Renamed Diner');

    const deleteRes = await authedFetch(cookie, `/api/sites/${site.id}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(200);

    const getAfterDelete = await authedFetch(cookie, `/api/sites/${site.id}`);
    expect(getAfterDelete.status).toBe(404);
  });

  it('a technician can read sites but cannot create, update, or delete them', async () => {
    const { cookie: ownerCookie, userId } = await signupOwner();
    const owner = await env.DB.prepare('SELECT company_id FROM users WHERE id = ?').bind(userId).first();
    const techCookie = await createTechnicianSession(owner.company_id, 'tech@sites.test');

    const createRes = await authedFetch(techCookie, '/api/sites', { method: 'POST', body: { name: 'Nope' } });
    expect(createRes.status).toBe(403);

    const { site } = await (
      await authedFetch(ownerCookie, '/api/sites', { method: 'POST', body: { name: 'Readable Site' } })
    ).json();

    const listRes = await authedFetch(techCookie, '/api/sites');
    expect(listRes.status).toBe(200);

    const updateRes = await authedFetch(techCookie, `/api/sites/${site.id}`, {
      method: 'PATCH',
      body: { name: 'Hijacked' },
    });
    expect(updateRes.status).toBe(403);

    const deleteRes = await authedFetch(techCookie, `/api/sites/${site.id}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(403);
  });

  it('refuses to delete a site that still has assets', async () => {
    const { cookie } = await signupOwner();
    const { site } = await (
      await authedFetch(cookie, '/api/sites', { method: 'POST', body: { name: 'Occupied Site' } })
    ).json();
    await authedFetch(cookie, `/api/sites/${site.id}/assets`, {
      method: 'POST',
      body: { label: 'Extinguisher #1', asset_type: 'fire_extinguisher', interval_days: 365 },
    });

    const deleteRes = await authedFetch(cookie, `/api/sites/${site.id}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(409);
  });
});

describe('assets', () => {
  it('computes next_due_at from install_date + interval_days when not given explicitly', async () => {
    const { cookie } = await signupOwner();
    const { site } = await (
      await authedFetch(cookie, '/api/sites', { method: 'POST', body: { name: 'Kitchen Site' } })
    ).json();

    const installDate = Date.UTC(2026, 0, 1);
    const createRes = await authedFetch(cookie, `/api/sites/${site.id}/assets`, {
      method: 'POST',
      body: {
        label: 'Kitchen Suppression System',
        asset_type: 'kitchen_suppression',
        interval_days: 180,
        install_date: installDate,
      },
    });
    expect(createRes.status).toBe(201);
    const { asset } = await createRes.json();
    expect(asset.next_due_at).toBe(installDate + 180 * DAY_MS);
    expect(asset.last_inspected_at).toBeNull();
  });

  it('an explicit next_due_at overrides the computed one', async () => {
    const { cookie } = await signupOwner();
    const { site } = await (
      await authedFetch(cookie, '/api/sites', { method: 'POST', body: { name: 'Alarm Site' } })
    ).json();

    const explicitDue = Date.now() + 5 * DAY_MS;
    const createRes = await authedFetch(cookie, `/api/sites/${site.id}/assets`, {
      method: 'POST',
      body: { label: 'Alarm Panel', asset_type: 'alarm_system', interval_days: 90, next_due_at: explicitDue },
    });
    const { asset } = await createRes.json();
    expect(asset.next_due_at).toBe(explicitDue);
  });

  it('rejects an unknown asset_type and a non-positive interval_days', async () => {
    const { cookie } = await signupOwner();
    const { site } = await (
      await authedFetch(cookie, '/api/sites', { method: 'POST', body: { name: 'Validation Site' } })
    ).json();

    const badType = await authedFetch(cookie, `/api/sites/${site.id}/assets`, {
      method: 'POST',
      body: { label: 'Mystery Device', asset_type: 'laser_grid', interval_days: 30 },
    });
    expect(badType.status).toBe(400);

    const badInterval = await authedFetch(cookie, `/api/sites/${site.id}/assets`, {
      method: 'POST',
      body: { label: 'Extinguisher', asset_type: 'fire_extinguisher', interval_days: 0 },
    });
    expect(badInterval.status).toBe(400);
  });

  it('404s creating an asset under a nonexistent site', async () => {
    const { cookie } = await signupOwner();
    const res = await authedFetch(cookie, '/api/sites/does-not-exist/assets', {
      method: 'POST',
      body: { label: 'Orphan', asset_type: 'fire_extinguisher', interval_days: 365 },
    });
    expect(res.status).toBe(404);
  });

  it('refuses to delete an asset that has inspection history', async () => {
    const { cookie, userId } = await signupOwner();
    const { site } = await (
      await authedFetch(cookie, '/api/sites', { method: 'POST', body: { name: 'Audit Site' } })
    ).json();
    const { asset } = await (
      await authedFetch(cookie, `/api/sites/${site.id}/assets`, {
        method: 'POST',
        body: { label: 'Sprinkler', asset_type: 'sprinkler_system', interval_days: 365 },
      })
    ).json();

    // Phase 4 doesn't exist yet, so seed the inspection row directly.
    const scope = withCompanyScope(env.DB, asset.company_id);
    await scope.insert('inspections', {
      id: crypto.randomUUID(),
      asset_id: asset.id,
      technician_user_id: userId,
      checklist_json: '{}',
      next_due_at_snapshot: asset.next_due_at,
      submitted_at: Date.now(),
    });

    const deleteRes = await authedFetch(cookie, `/api/assets/${asset.id}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(409);
  });
});

describe('dashboard', () => {
  it('returns only assets due within the window, grouped by site, ordered soonest-first', async () => {
    const { cookie } = await signupOwner();
    const siteA = (await (await authedFetch(cookie, '/api/sites', { method: 'POST', body: { name: 'Dash Site A' } })).json())
      .site;
    const siteB = (await (await authedFetch(cookie, '/api/sites', { method: 'POST', body: { name: 'Dash Site B' } })).json())
      .site;

    const now = Date.now();
    await authedFetch(cookie, `/api/sites/${siteA.id}/assets`, {
      method: 'POST',
      body: {
        label: 'Due soon',
        asset_type: 'fire_extinguisher',
        interval_days: 1,
        next_due_at: now + 5 * DAY_MS,
      },
    });
    await authedFetch(cookie, `/api/sites/${siteA.id}/assets`, {
      method: 'POST',
      body: {
        label: 'Overdue',
        asset_type: 'fire_extinguisher',
        interval_days: 1,
        next_due_at: now - 5 * DAY_MS,
      },
    });
    await authedFetch(cookie, `/api/sites/${siteB.id}/assets`, {
      method: 'POST',
      body: {
        label: 'Far future',
        asset_type: 'alarm_system',
        interval_days: 1,
        next_due_at: now + 365 * DAY_MS,
      },
    });

    const res = await authedFetch(cookie, '/api/dashboard?days=30');
    expect(res.status).toBe(200);
    const body = await res.json();

    const siteAGroup = body.sites.find((s) => s.site_id === siteA.id);
    const siteBGroup = body.sites.find((s) => s.site_id === siteB.id);

    expect(siteAGroup.assets.map((a) => a.label)).toEqual(['Overdue', 'Due soon']);
    expect(siteBGroup).toBeUndefined();
  });

  it('rejects a non-positive days parameter', async () => {
    const { cookie } = await signupOwner();
    const res = await authedFetch(cookie, '/api/dashboard?days=-1');
    expect(res.status).toBe(400);
  });
});
