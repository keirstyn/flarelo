// Photo and signature upload, decoupled from inspection submit.
//
// This is NOT a literal S3-style presigned URL (that needs a separate
// R2 API token + the aws4fetch package + new secrets). Instead each
// photo/signature is its own small authenticated request straight to
// the Worker, which streams it to R2 via the existing binding. Same
// practical goal as a signed URL — one photo failing to upload on bad
// signal doesn't blow away the whole in-progress inspection — with no
// new infrastructure. Revisit with real presigned URLs only if upload
// volume or Worker CPU time actually becomes a problem.
import { withCompanyScope } from '../db/withCompanyScope.js';
import { authenticate } from '../auth/middleware.js';
import { json } from '../lib/http.js';

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB per file, generous for a phone photo
const ALLOWED_PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

async function handleUpload({ request, env, assetId, kind, allowedTypes, keyPrefix }) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });

  const scope = withCompanyScope(env.DB, auth.user.company_id);
  const asset = await scope.findById('assets', assetId);
  if (!asset) return json({ error: 'Asset not found' }, { status: 404 });

  const contentType = request.headers.get('Content-Type') || '';
  const ext = allowedTypes[contentType];
  if (!ext) {
    return json({ error: `Unsupported content type for ${kind}: ${contentType}` }, { status: 400 });
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return json({ error: `${kind} upload was empty` }, { status: 400 });
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return json({ error: `${kind} exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit` }, { status: 413 });
  }

  const key = `${keyPrefix}/${auth.user.company_id}/${asset.id}/${crypto.randomUUID()}.${ext}`;
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType } });

  return json({ key }, { status: 201 });
}

export async function handleUploadPhoto(request, env, ctx, params) {
  return handleUpload({
    request,
    env,
    assetId: params.assetId,
    kind: 'photo',
    allowedTypes: ALLOWED_PHOTO_TYPES,
    keyPrefix: 'photos',
  });
}

export async function handleUploadSignature(request, env, ctx, params) {
  return handleUpload({
    request,
    env,
    assetId: params.assetId,
    kind: 'signature',
    allowedTypes: { 'image/png': 'png' },
    keyPrefix: 'signatures',
  });
}
