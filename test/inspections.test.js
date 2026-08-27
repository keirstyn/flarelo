import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import schemaSql from '../db/schema.sql?raw';
import { getChecklistForAssetType } from '../src/lib/checklists.js';

function parseStatements(sql) {
  return sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean);
}

beforeAll(async () => {
  const statements = parseStatements(schemaSql);
  await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
});

const fakeBase64 = btoa('fake-bytes');

async function signupOwner() {
  const res = await SELF.fetch('https://example.com/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      email: `owner-${crypto.randomUUID()}@insp.test`,
      password: 'ownerpassword1',
      companyName: 'Insp Co',
    }),
  });
  const cookie = res.headers.get('Set-Cookie').split(';')[0];
  return cookie;
}

function authedFetch(cookie, path, { method = 'GET', body } = {}) {
  return SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function setupAsset(cookie) {
  const { site } = await (await authedFetch(cookie, '/api/sites', { method: 'POST', body: { name: 'Main St' } })).json();
  const { asset } = await (
    await authedFetch(cookie, `/api/sites/${site.id}/assets`, {
      method: 'POST',
      body: { label: 'Extinguisher #1', asset_type: 'fire_extinguisher', interval_days: 90 },
    })
  ).json();
  return asset;
}

describe('inspection submission', () => {
  it('rejects a submission missing a checklist answer', async () => {
    const cookie = await signupOwner();
    const asset = await setupAsset(cookie);
    const checklist = getChecklistForAssetType('fire_extinguisher');
    const incompleteAnswers = checklist.slice(1).map((item) => ({ item_id: item.id, status: 'pass' }));

    const res = await authedFetch(cookie, `/api/assets/${asset.id}/inspections`, {
      method: 'POST',
      body: { answers: incompleteAnswers, signature: fakeBase64 },
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid answer status', async () => {
    const cookie = await signupOwner();
    const asset = await setupAsset(cookie);
    const checklist = getChecklistForAssetType('fire_extinguisher');
    const badAnswers = checklist.map((item) => ({ item_id: item.id, status: 'maybe' }));

    const res = await authedFetch(cookie, `/api/assets/${asset.id}/inspections`, {
      method: 'POST',
      body: { answers: badAnswers, signature: fakeBase64 },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a submission with no signature', async () => {
    const cookie = await signupOwner();
    const asset = await setupAsset(cookie);
    const checklist = getChecklistForAssetType('fire_extinguisher');

    const res = await authedFetch(cookie, `/api/assets/${asset.id}/inspections`, {
      method: 'POST',
      body: { answers: checklist.map((i) => ({ item_id: i.id, status: 'pass' })) },
    });
    expect(res.status).toBe(400);
  });

  it('a valid submission stores the PDF/photos/signature, updates the asset, and writes the inspection row', async () => {
    const cookie = await signupOwner();
    const asset = await setupAsset(cookie);
    const originalNextDue = asset.next_due_at;
    const checklist = getChecklistForAssetType('fire_extinguisher');
    const answers = checklist.map((item, i) => ({
      item_id: item.id,
      status: i === 0 ? 'fail' : 'pass',
      notes: i === 0 ? 'gauge in red zone' : undefined,
    }));

    const res = await authedFetch(cookie, `/api/assets/${asset.id}/inspections`, {
      method: 'POST',
      body: { answers, signature: fakeBase64, photos: [fakeBase64, fakeBase64] },
    });
    expect(res.status).toBe(201);
    const { inspection } = await res.json();
    expect(inspection.asset_id).toBe(asset.id);
    expect(JSON.parse(inspection.photo_r2_keys).length).toBe(2);
    expect(inspection.signature_r2_key).toBeTruthy();
    expect(inspection.pdf_r2_key).toBeTruthy();

    const pdfObject = await env.BUCKET.get(inspection.pdf_r2_key);
    expect(pdfObject).not.toBeNull();

    const updatedAssetRes = await authedFetch(cookie, `/api/assets/${asset.id}`);
    const { asset: updatedAsset } = await updatedAssetRes.json();
    expect(updatedAsset.next_due_at).toBeGreaterThan(originalNextDue);
    expect(updatedAsset.last_inspected_at).not.toBeNull();

    const pdfFetchRes = await authedFetch(cookie, `/api/inspections/${inspection.id}/pdf`);
    expect(pdfFetchRes.status).toBe(200);
    expect(pdfFetchRes.headers.get('Content-Type')).toBe('application/pdf');
  });

  it('404s submitting against an asset in another company', async () => {
    const cookieA = await signupOwner();
    const assetA = await setupAsset(cookieA);
    const cookieB = await signupOwner();

    const checklist = getChecklistForAssetType('fire_extinguisher');
    const res = await authedFetch(cookieB, `/api/assets/${assetA.id}/inspections`, {
      method: 'POST',
      body: { answers: checklist.map((i) => ({ item_id: i.id, status: 'pass' })), signature: fakeBase64 },
    });
    expect(res.status).toBe(404);
  });
});
