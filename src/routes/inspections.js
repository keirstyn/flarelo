import { withCompanyScope } from '../db/withCompanyScope.js';
import { authenticate } from '../auth/middleware.js';
import { json, readJson } from '../lib/http.js';
import { getChecklistForAssetType } from '../lib/checklists.js';
import { generateInspectionPdf } from '../lib/generateInspectionPdf.js';
import { sendEmail } from '../lib/email.js';

const DAY_MS = 1000 * 60 * 60 * 24;
const VALID_STATUSES = ['pass', 'fail', 'na'];
const MAX_PHOTOS = 20;

// Submit takes R2 KEYS for the signature and photos, not raw bytes —
// those are uploaded separately first via uploads.js, each as its own
// small retryable request. This function only validates the keys
// belong to this company+asset and actually exist in R2 before
// trusting them; it never receives or decodes binary payloads itself.
//
// Third parameter after params: same test-injection pattern as
// handleInvite/handleRequestPasswordReset in auth.js — a real
// ExecutionContext has neither generatePdfFn nor sendEmailFn, so
// production behavior is unaffected; tests can override either.
export async function handleSubmitInspection(
  request,
  env,
  ctx,
  params,
  { generatePdfFn = generateInspectionPdf, sendEmailFn = sendEmail } = {}
) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });

  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const asset = await scope.findById('assets', params.assetId);
  if (!asset) return json({ error: 'Asset not found' }, { status: 404 });
  const site = await scope.findById('sites', asset.site_id);

  const body = await readJson(request);
  if (!body || !Array.isArray(body.answers) || !body.signature_key) {
    return json({ error: 'answers (array) and signature_key are required' }, { status: 400 });
  }

  const checklist = getChecklistForAssetType(asset.asset_type);
  const answerByItem = new Map(body.answers.map((a) => [a.item_id, a]));
  for (const item of checklist) {
    const answer = answerByItem.get(item.id);
    if (!answer || !VALID_STATUSES.includes(answer.status)) {
      return json({ error: `Missing or invalid answer for checklist item "${item.id}"` }, { status: 400 });
    }
  }

  const photoKeys = Array.isArray(body.photo_keys) ? body.photo_keys : [];
  if (photoKeys.length > MAX_PHOTOS) {
    return json({ error: `Too many photos (max ${MAX_PHOTOS})` }, { status: 400 });
  }

  const signaturePrefix = `signatures/${auth.user.company_id}/${asset.id}/`;
  const photoPrefix = `photos/${auth.user.company_id}/${asset.id}/`;
  if (!body.signature_key.startsWith(signaturePrefix)) {
    return json({ error: 'signature_key does not belong to this asset' }, { status: 400 });
  }
  for (const key of photoKeys) {
    if (typeof key !== 'string' || !key.startsWith(photoPrefix)) {
      return json({ error: 'a photo_key does not belong to this asset' }, { status: 400 });
    }
  }

  // Confirm every referenced upload actually landed in R2 — catches a
  // client that raced ahead of a failed/slow upload rather than
  // trusting the key string alone.
  const signatureObject = await env.BUCKET.get(body.signature_key);
  if (!signatureObject) {
    return json({ error: 'signature was not found — please retry the upload' }, { status: 400 });
  }
  for (const key of photoKeys) {
    const head = await env.BUCKET.head(key);
    if (!head) return json({ error: 'a photo was not found — please retry the upload' }, { status: 400 });
  }

  const signatureBytes = await signatureObject.arrayBuffer();
  const inspectionId = crypto.randomUUID();
  const now = Date.now();

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
    signature_r2_key: body.signature_key,
    pdf_r2_key: pdfKey,
    next_due_at_snapshot: nextDueAt,
    submitted_at: now,
  });
  await scope.update('assets', asset.id, { next_due_at: nextDueAt, last_inspected_at: now });

  // Auto-create a deficiency for every failed checklist item — this
  // is the "record deficiencies" + "create follow-up work" automation.
  // Never fails the submission if something downstream (email) breaks.
  const failedAnswers = body.answers.filter((a) => a.status === 'fail');
  const deficiencyRows = [];
  for (const answer of failedAnswers) {
    const item = checklist.find((c) => c.id === answer.item_id);
    const description = answer.notes ? `${item?.label ?? answer.item_id} — ${answer.notes}` : item?.label ?? answer.item_id;
    const deficiencyId = crypto.randomUUID();
    await scope.insert('deficiencies', {
      id: deficiencyId,
      inspection_id: inspectionId,
      asset_id: asset.id,
      checklist_item_id: answer.item_id,
      description,
      status: 'open',
      created_at: now,
    });
    deficiencyRows.push({ id: deficiencyId, description });
  }

  // Best-effort office alert — never blocks the submission response.
  if (deficiencyRows.length > 0) {
    try {
      const owner = await scope.first("SELECT email FROM users WHERE company_id = ? AND role = 'owner'");
      if (owner?.email) {
        await sendEmailFn(env, {
          to: owner.email,
          subject: `Deficiency found — ${asset.label} at ${site?.name ?? 'site'}`,
          body:
            `A submitted inspection found ${deficiencyRows.length} deficiency/deficiencies on ` +
            `${asset.label} (${site?.name ?? 'site'}):\n\n` +
            deficiencyRows.map((d) => `- ${d.description}`).join('\n'),
        });
      }
    } catch (err) {
      console.error('Failed to send deficiency alert email', err);
    }
  }

  // Best-effort customer notification — plain text placeholder.
  // Emailing the actual PDF (with SPF/DKIM verified) is Phase 6.
  if (site?.contact_email) {
    try {
      await sendEmailFn(env, {
        to: site.contact_email,
        subject: `Inspection completed — ${asset.label}`,
        body: `An inspection of ${asset.label} at ${site.name} was completed on ${new Date(now).toISOString().slice(0, 10)}. A detailed report is available on request.`,
      });
    } catch (err) {
      console.error('Failed to send customer notification email', err);
    }
  }

  const inspection = await scope.findById('inspections', inspectionId);
  return json({ inspection, deficiencies: deficiencyRows }, { status: 201 });
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
