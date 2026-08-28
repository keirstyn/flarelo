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

const fakeBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

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

async function uploadFile(cookie, path, contentType, bytes) {
  const res = await SELF.fetch(`https://example.com${path}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': contentType },
    body: bytes,
  });
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  const { key } = await res.json();
  return key;
}

const uploadSignature = (cookie, assetId) =>
  uploadFile(cookie, `/api/assets/${assetId}/signature`, 'image/png', base64ToBytes(fakeBase64));
const uploadPhoto = (cookie, assetId) =>
  uploadFile(cookie, `/api/assets/${assetId}/photos`, 'image/png', base64ToBytes(fakeBase64));

describe('photo/signature upload', () => {
  it('rejects an unsupported content type', async () => {
    const cookie = await signupOwner();
    const asset = await setupAsset(cookie);
    const res = await SELF.fetch(`https://example.com/api/assets/${asset.id}/photos`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/pdf' },
      body: base64ToBytes(fakeBase64),
    });
    expect(res.status).toBe(400);
  });

  it("404s uploading against another company's asset", async () => {
    const cookieA = await signupOwner();
    const assetA = await setupAsset(cookieA);
    const cookieB = await signupOwner();
    const res = await SELF.fetch(`https://example.com/api/assets/${assetA.id}/photos`, {
      method: 'POST',
      headers: { Cookie: cookieB, 'Content-Type': 'image/png' },
      body: base64ToBytes(fakeBase64),
    });
    expect(res.status).toBe(404);
  });
});

describe('inspection submission', () => {
  it('rejects a submission missing a checklist answer', async () => {
    const cookie = await signupOwner();
    const asset = await setupAsset(cookie);
    const checklist = getChecklistForAssetType('fire_extinguisher');
    const incompleteAnswers = checklist.slice(1).map((item) => ({ item_id: item.id, status: 'pass' }));
    const res = await authedFetch(cookie, `/api/assets/${asset.id}/inspections`, {
      method: 'POST',
      body: { answers: incompleteAnswers, signature_key: `signatures/x/${asset.id}/placeholder.png` },
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
      body: { answers: badAnswers, signature_key: `signatures/x/${asset.id}/placeholder.png` },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a submission with no signature_key', async () => {
    const cookie = await signupOwner();
    const asset = await setupAsset(cookie);
    const checklist = getChecklistForAssetType('fire_extinguisher');
    const res = await authedFetch(cookie, `/api/assets/${asset.id}/inspections`, {
      method: 'POST',
      body: { answers: checklist.map((i) => ({ item_id: i.id, status: 'pass' })) },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a signature_key that does not belong to this asset', async () => {
    const cookie = await signupOwner();
    const asset1 = await setupAsset(cookie);
    const asset2 = await setupAsset(cookie);
    const wrongAssetKey = await uploadSignature(cookie, asset1.id);
    const checklist = getChecklistForAssetType('fire_extinguisher');
    const res = await authedFetch(cookie, `/api/assets/${asset2.id}/inspections`, {
      method: 'POST',
      body: { answers: checklist.map((i) => ({ item_id: i.id, status: 'pass' })), signature_key: wrongAssetKey },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a signature_key with a valid prefix that was never actually uploaded', async () => {
    const cookie = await signupOwner();
    const asset = await setupAsset(cookie);
    const realKey = await uploadSignature(cookie, asset.id);
    const prefix = realKey.slice(0, realKey.lastIndexOf('/') + 1);
    const neverUploadedKey = `${prefix}${crypto.randomUUID()}.png`;
    const checklist = getChecklistForAssetType('fire_extinguisher');
    const res = await authedFetch(cookie, `/api/assets/${asset.id}/inspections`, {
      method: 'POST',
      body: { answers: checklist.map((i) => ({ item_id: i.id, status: 'pass' })), signature_key: neverUploadedKey },
    });
    expect(res.status).toBe(400);
  });

  it('a valid submission stores the PDF/photos/signature, updates the asset, and records a deficiency', async () => {
    const cookie = await signupOwner();
    const asset = await setupAsset(cookie);
    const originalNextDue = asset.next_due_at;
    const checklist = getChecklistForAssetType('fire_extinguisher');
    const answers = checklist.map((item, i) => ({
      item_id: item.id,
      status: i === 0 ? 'fail' : 'pass',
      notes: i === 0 ? 'gauge in red zone' : undefined,
    }));

    const signatureKey = await uploadSignature(cookie, asset.id);
    const photoKey1 = await uploadPhoto(cookie, asset.id);
    const photoKey2 = await uploadPhoto(cookie, asset.id);

    const res = await authedFetch(cookie, `/api/assets/${asset.id}/inspections`, {
      method: 'POST',
      body: { answers, signature_key: signatureKey, photo_keys: [photoKey1, photoKey2] },
    });
    expect(res.status).toBe(201);
    const { inspection, deficiencies } = await res.json();
    expect(inspection.asset_id).toBe(asset.id);
    expect(JSON.parse(inspection.photo_r2_keys).length).toBe(2);
    expect(inspection.signature_r2_key).toBe(signatureKey);
    expect(inspection.pdf_r2_key).toBeTruthy();

    expect(deficiencies.length).toBe(1);
    expect(deficiencies[0].description).toContain('gauge in red zone');

    const pdfObject = await env.BUCKET.get(inspection.pdf_r2_key);
    expect(pdfObject).not.toBeNull();
    await pdfObject.arrayBuffer();

    const updatedAssetRes = await authedFetch(cookie, `/api/assets/${asset.id}`);
    const { asset: updatedAsset } = await updatedAssetRes.json();
    expect(updatedAsset.next_due_at).toBeGreaterThan(originalNextDue);
    expect(updatedAsset.last_inspected_at).not.toBeNull();

    const pdfFetchRes = await authedFetch(cookie, `/api/inspections/${inspection.id}/pdf`);
    expect(pdfFetchRes.status).toBe(200);
    expect(pdfFetchRes.headers.get('Content-Type')).toBe('application/pdf');
    await pdfFetchRes.arrayBuffer();

    const openDeficienciesRes = await authedFetch(cookie, '/api/deficiencies?status=open');
    const { deficiencies: openDeficiencies } = await openDeficienciesRes.json();
    expect(openDeficiencies.some((d) => d.id === deficiencies[0].id)).toBe(true);
  });

  it('404s submitting against an asset in another company', async () => {
    const cookieA = await signupOwner();
    const assetA = await setupAsset(cookieA);
    const cookieB = await signupOwner();
    const checklist = getChecklistForAssetType('fire_extinguisher');
    const res = await authedFetch(cookieB, `/api/assets/${assetA.id}/inspections`, {
      method: 'POST',
      body: {
        answers: checklist.map((i) => ({ item_id: i.id, status: 'pass' })),
        signature_key: `signatures/x/${assetA.id}/placeholder.png`,
      },
    });
    expect(res.status).toBe(404);
  });
});
