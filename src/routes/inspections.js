import { withCompanyScope } from '../db/withCompanyScope.js';
import { authenticate } from '../auth/middleware.js';
import { json, readJson } from '../lib/http.js';
import { getChecklistForAssetType } from '../lib/checklists.js';
import { base64ToBytes } from '../lib/base64.js';
import { generateInspectionPdf } from '../lib/generateInspectionPdf.js';

const DAY_MS = 1000 * 60 * 60 * 24;
const VALID_STATUSES = ['pass', 'fail', 'na'];

function decodeBase64OrNull(str) {
  try {
    return base64ToBytes(str);
  } catch {
    return null;
  }
}

export async function handleSubmitInspection(request, env, ctx, params, { generatePdfFn = generateInspectionPdf } = {}) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });

  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const asset = await scope.findById('assets', params.assetId);
  if (!asset) return json({ error: 'Asset not found' }, { status: 404 });
  const site = await scope.findById('sites', asset.site_id);

  const body = await readJson(request);
  if (!body || !Array.isArray(body.answers) || !body.signature) {
    return json({ error: 'answers (array) and signature (base64) are required' }, { status: 400 });
  }

  const checklist = getChecklistForAssetType(asset.asset_type);
  const answerByItem = new Map(body.answers.map((a) => [a.item_id, a]));
  for (const item of checklist) {
    const answer = answerByItem.get(item.id);
    if (!answer || !VALID_STATUSES.includes(answer.status)) {
      return json({ error: `Missing or invalid answer for checklist item "${item.id}"` }, { status: 400 });
    }
  }

  const signatureBytes = decodeBase64OrNull(body.signature);
  if (!signatureBytes) return json({ error: 'signature is not valid base64' }, { status: 400 });

  const photoBytesList = [];
  for (const photoBase64 of body.photos || []) {
    const bytes = decodeBase64OrNull(photoBase64);
    if (!bytes) return json({ error: 'a photo is not valid base64' }, { status: 400 });
    photoBytesList.push(bytes);
  }

  const inspectionId = crypto.randomUUID();
  const now = Date.now();

  const signatureKey = `signatures/${auth.user.company_id}/${asset.id}/${inspectionId}.png`;
  await env.BUCKET.put(signatureKey, signatureBytes);

  const photoKeys = [];
  for (const [index, bytes] of photoBytesList.entries()) {
    const key = `photos/${auth.user.company_id}/${asset.id}/${inspectionId}/${index}.jpg`;
    await env.BUCKET.put(key, bytes);
    photoKeys.push(key);
  }

  const company = await env.DB.prepare('SELECT name FROM companies WHERE id = ?').bind(auth.user.company_id).first();
  const pdfBytes = await generatePdfFn({
    companyName: company?.name ?? '',
    siteName: site?.name ?? '',
    assetLabel: asset.label,
    assetType: asset.asset_type,
    technicianEmail: auth.user.email,
    submittedAt: now,
    checklist,
    answers: body.answers,
    signaturePngBytes: signatureBytes,
  });
  const pdfKey = `reports/${auth.user.company_id}/${asset.id}/${inspectionId}.pdf`;
  await env.BUCKET.put(pdfKey, pdfBytes);

  const nextDueAt = now + asset.interval_days * DAY_MS;

  await scope.insert('inspections', {
    id: inspectionId,
    asset_id: asset.id,
    technician_user_id: auth.user.id,
    checklist_json: JSON.stringify(body.answers),
    photo_r2_keys: JSON.stringify(photoKeys),
    signature_r2_key: signatureKey,
    pdf_r2_key: pdfKey,
    next_due_at_snapshot: nextDueAt,
    submitted_at: now,
  });

  await scope.update('assets', asset.id, { next_due_at: nextDueAt, last_inspected_at: now });

  const inspection = await scope.findById('inspections', inspectionId);
  return json({ inspection }, { status: 201 });
}

export async function handleGetInspectionPdf(request, env, ctx, params) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });

  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const inspection = await scope.findById('inspections', params.id);
  if (!inspection) return json({ error: 'Inspection not found' }, { status: 404 });

  const object = await env.BUCKET.get(inspection.pdf_r2_key);
  if (!object) return json({ error: 'PDF not found in storage' }, { status: 404 });

  return new Response(object.body, { status: 200, headers: { 'Content-Type': 'application/pdf' } });
}
