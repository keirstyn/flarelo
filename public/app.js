// Flarelo — technician-facing mobile app. Vanilla JS, no build step,
// no framework: served directly as a static asset by the Worker (see
// wrangler.jsonc's `assets` binding). What's pasted is what runs.
//
// Flow: login -> site picker -> asset picker -> inspection form -> submit.
// Office/owner dashboard views are a separate future page, not this one.

const root = document.getElementById('app');
let currentUser = null;

// ---------- tiny fetch helpers ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: options.body && !(options.body instanceof Blob) && !(options.body instanceof ArrayBuffer)
      ? { 'Content-Type': 'application/json', ...(options.headers || {}) }
      : options.headers,
  });
  return res;
}

async function apiJson(path, options = {}) {
  const res = await api(path, {
    ...options,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { res, data };
}

// ---------- draft persistence (survives reload / bad signal) ----------

function draftKey(assetId) {
  return `flarelo_draft_${assetId}`;
}

function loadDraft(assetId) {
  try {
    const raw = localStorage.getItem(draftKey(assetId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveDraft(assetId, draft) {
  try {
    localStorage.setItem(draftKey(assetId), JSON.stringify(draft));
  } catch {
    // storage full or unavailable — inspection still works, it just
    // won't survive a reload. Not worth failing the flow over.
  }
}

function clearDraft(assetId) {
  try { localStorage.removeItem(draftKey(assetId)); } catch { /* ignore */ }
}

// ---------- rendering ----------

function render(html) {
  root.innerHTML = html;
}

function statusBadge(nextDueAt) {
  const now = Date.now();
  const days = (nextDueAt - now) / (1000 * 60 * 60 * 24);
  if (days < 0) return '<span class="badge badge-overdue">Overdue</span>';
  if (days <= 30) return '<span class="badge badge-soon">Due soon</span>';
  return '<span class="badge badge-ok">OK</span>';
}

function assetTypeLabel(type) {
  return {
    fire_extinguisher: 'Fire Extinguisher',
    alarm_system: 'Alarm System',
    sprinkler_system: 'Sprinkler System',
    kitchen_suppression: 'Kitchen Suppression',
  }[type] || type;
}

// ---------- views ----------

async function showLogin(message) {
  render(`
    <div class="screen">
      <h1>Flarelo</h1>
      ${message ? `<p class="error">${message}</p>` : ''}
      <form id="login-form">
        <label>Email<input type="email" name="email" required autocomplete="username"></label>
        <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
        <button type="submit">Log in</button>
      </form>
      <p class="switch-link">New company? <a href="#" id="show-signup-link">Sign up</a></p>
    </div>
  `);
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const submitBtn = e.target.querySelector('button');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Logging in…';
    const { res, data } = await apiJson('/api/auth/login', {
      method: 'POST',
      body: { email: form.get('email'), password: form.get('password') },
    });
    if (res.status === 200) {
      await boot();
    } else {
      showLogin(data?.error || 'Login failed');
    }
  });
  document.getElementById('show-signup-link').addEventListener('click', (e) => {
    e.preventDefault();
    showSignup();
  });
}

// Creates a brand-new company + owner account — this is the ONLY
// signup path, matching the backend: a second person on an existing
// company always comes in via an owner-sent invite, never this form.
async function showSignup(message) {
  render(`
    <div class="screen">
      <h1>Create your company</h1>
      ${message ? `<p class="error">${message}</p>` : ''}
      <form id="signup-form">
        <label>Company name<input type="text" name="companyName" required></label>
        <label>Your email<input type="email" name="email" required autocomplete="username"></label>
        <label>Password<input type="password" name="password" required autocomplete="new-password" minlength="8"></label>
        <button type="submit">Create account</button>
      </form>
      <p class="switch-link">Already have an account? <a href="#" id="show-login-link">Log in</a></p>
    </div>
  `);
  document.getElementById('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const submitBtn = e.target.querySelector('button');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating…';
    const { res, data } = await apiJson('/api/auth/signup', {
      method: 'POST',
      body: {
        companyName: form.get('companyName'),
        email: form.get('email'),
        password: form.get('password'),
      },
    });
    if (res.status === 201) {
      await boot();
    } else {
      showSignup(data?.error || 'Signup failed');
    }
  });
  document.getElementById('show-login-link').addEventListener('click', (e) => {
    e.preventDefault();
    showLogin();
  });
}

async function showSitePicker() {
  render(`<div class="screen"><h1>Sites</h1><p class="loading">Loading…</p></div>`);
  const { res, data } = await apiJson('/api/sites');
  if (res.status !== 200) return showLogin('Session expired — please log in again.');
  const sites = data.sites || [];
  render(`
    <div class="screen">
      <header class="topbar">
        <h1>Sites</h1>
        <button class="logout" id="logout-btn">Log out</button>
      </header>
      ${sites.length === 0 ? '<p>No sites yet.</p>' : ''}
      <ul class="list">
        ${sites.map((s) => `
          <li class="list-item" data-site-id="${s.id}">
            <div class="list-item-title">${escapeHtml(s.name)}</div>
            ${s.address ? `<div class="list-item-sub">${escapeHtml(s.address)}</div>` : ''}
          </li>
        `).join('')}
      </ul>
    </div>
  `);
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.querySelectorAll('.list-item[data-site-id]').forEach((el) => {
    el.addEventListener('click', () => showAssetPicker(el.dataset.siteId));
  });
}

async function showAssetPicker(siteId) {
  render(`<div class="screen"><p class="loading">Loading…</p></div>`);
  const { res, data } = await apiJson(`/api/sites/${siteId}/assets`);
  if (res.status !== 200) return showSitePicker();
  const assets = data.assets || [];
  render(`
    <div class="screen">
      <header class="topbar">
        <button class="back" id="back-btn">&larr;</button>
        <h1>Assets</h1>
      </header>
      ${assets.length === 0 ? '<p>No assets at this site yet.</p>' : ''}
      <ul class="list">
        ${assets.map((a) => `
          <li class="list-item" data-asset-id="${a.id}">
            <div class="list-item-title">${escapeHtml(a.label)}</div>
            <div class="list-item-sub">${assetTypeLabel(a.asset_type)} · Due ${new Date(a.next_due_at).toLocaleDateString()}</div>
            ${statusBadge(a.next_due_at)}
          </li>
        `).join('')}
      </ul>
    </div>
  `);
  document.getElementById('back-btn').addEventListener('click', showSitePicker);
  document.querySelectorAll('.list-item[data-asset-id]').forEach((el) => {
    el.addEventListener('click', () => showInspectionForm(el.dataset.assetId, siteId));
  });
}

async function showInspectionForm(assetId, siteId) {
  render(`<div class="screen"><p class="loading">Loading checklist…</p></div>`);
  const { res: assetRes, data: assetData } = await apiJson(`/api/assets/${assetId}`);
  const { res: checklistRes, data: checklistData } = await apiJson(`/api/assets/${assetId}/checklist`);
  if (assetRes.status !== 200 || checklistRes.status !== 200) return showAssetPicker(siteId);

  const asset = assetData.asset;
  const checklist = checklistData.checklist;
  const draft = loadDraft(assetId) || { answers: {}, photoKeys: [], signatureKey: null };

  render(`
    <div class="screen">
      <header class="topbar">
        <button class="back" id="back-btn">&larr;</button>
        <h1>${escapeHtml(asset.label)}</h1>
      </header>
      <p class="sub">${assetTypeLabel(asset.asset_type)}</p>

      <form id="inspection-form">
        <div id="checklist">
          ${checklist.map((item) => renderChecklistItem(item, draft.answers[item.id])).join('')}
        </div>

        <div class="section">
          <h2>Photos</h2>
          <div id="photo-list" class="photo-list"></div>
          <input type="file" id="photo-input" accept="image/*" capture="environment" multiple hidden>
          <button type="button" id="add-photo-btn">Take Photo</button>
        </div>

        <div class="section">
          <h2>Signature</h2>
          <canvas id="signature-pad" width="600" height="200"></canvas>
          <div class="sig-controls">
            <button type="button" id="clear-sig-btn">Clear</button>
            <span id="sig-status" class="sig-status"></span>
          </div>
        </div>

        <p id="submit-error" class="error"></p>
        <button type="submit" id="submit-btn">Submit Inspection</button>
      </form>
    </div>
  `);

  document.getElementById('back-btn').addEventListener('click', () => showAssetPicker(siteId));

  // ---- checklist answer capture ----
  function collectAnswers() {
    const answers = {};
    document.querySelectorAll('.checklist-item').forEach((el) => {
      const itemId = el.dataset.itemId;
      const selected = el.querySelector('input[type=radio]:checked');
      const notes = el.querySelector('.notes-input').value.trim();
      if (selected) answers[itemId] = { status: selected.value, notes: notes || undefined };
    });
    return answers;
  }

  function persistDraft() {
    draft.answers = collectAnswers();
    saveDraft(assetId, draft);
  }

  document.querySelectorAll('.checklist-item input, .checklist-item textarea').forEach((el) => {
    el.addEventListener('change', persistDraft);
  });

  // ---- photos ----
  function renderPhotoList() {
    const list = document.getElementById('photo-list');
    list.innerHTML = draft.photoKeys.map((k, i) => `<div class="photo-chip">Photo ${i + 1} &check;</div>`).join('');
  }
  renderPhotoList();

  document.getElementById('add-photo-btn').addEventListener('click', () => {
    document.getElementById('photo-input').click();
  });

  document.getElementById('photo-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      const chipList = document.getElementById('photo-list');
      const placeholder = document.createElement('div');
      placeholder.className = 'photo-chip photo-chip-pending';
      placeholder.textContent = 'Uploading…';
      chipList.appendChild(placeholder);
      try {
        const key = await uploadWithRetry(`/api/assets/${assetId}/photos`, file.type, file);
        draft.photoKeys.push(key);
        saveDraft(assetId, draft);
        renderPhotoList();
      } catch {
        placeholder.textContent = 'Failed — tap to retry';
        placeholder.classList.add('photo-chip-failed');
        placeholder.addEventListener('click', async () => {
          placeholder.textContent = 'Uploading…';
          try {
            const key = await uploadWithRetry(`/api/assets/${assetId}/photos`, file.type, file);
            draft.photoKeys.push(key);
            saveDraft(assetId, draft);
            renderPhotoList();
          } catch {
            placeholder.textContent = 'Failed — tap to retry';
          }
        });
      }
    }
    e.target.value = '';
  });

  // ---- signature pad ----
  const canvas = document.getElementById('signature-pad');
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#111';
  let drawing = false;
  let hasStrokes = false;

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    hasStrokes = true;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });
  ['pointerup', 'pointerleave'].forEach((evt) =>
    canvas.addEventListener(evt, () => { drawing = false; })
  );

  document.getElementById('clear-sig-btn').addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasStrokes = false;
    draft.signatureKey = null;
    saveDraft(assetId, draft);
    document.getElementById('sig-status').textContent = '';
  });

  async function ensureSignatureUploaded() {
    if (draft.signatureKey) return draft.signatureKey;
    if (!hasStrokes) throw new Error('Signature is required');
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const key = await uploadWithRetry(`/api/assets/${assetId}/signature`, 'image/png', blob);
    draft.signatureKey = key;
    saveDraft(assetId, draft);
    document.getElementById('sig-status').textContent = 'Saved';
    return key;
  }

  // ---- submit ----
  document.getElementById('inspection-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('submit-btn');
    const errorEl = document.getElementById('submit-error');
    errorEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    try {
      const answers = collectAnswers();
      const missing = checklist.filter((item) => !answers[item.id]);
      if (missing.length > 0) throw new Error(`Answer every item — missing: ${missing.map((m) => m.label).join(', ')}`);

      const signatureKey = await ensureSignatureUploaded();
      const answersArray = checklist.map((item) => ({ item_id: item.id, ...answers[item.id] }));

      const { res, data } = await apiJson(`/api/assets/${assetId}/inspections`, {
        method: 'POST',
        body: { answers: answersArray, signature_key: signatureKey, photo_keys: draft.photoKeys },
      });

      if (res.status !== 201) throw new Error(data?.error || 'Submission failed — please try again.');

      clearDraft(assetId);
      showSubmitSuccess(siteId, data.deficiencies || []);
    } catch (err) {
      errorEl.textContent = err.message + ' Your answers and uploads are saved — safe to retry.';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Inspection';
    }
  });
}

function renderChecklistItem(item, savedAnswer) {
  const status = savedAnswer?.status || '';
  const notes = savedAnswer?.notes || '';
  return `
    <div class="checklist-item" data-item-id="${item.id}">
      <p class="checklist-label">${escapeHtml(item.label)}</p>
      <div class="status-buttons">
        <label class="status-opt"><input type="radio" name="status-${item.id}" value="pass" ${status === 'pass' ? 'checked' : ''}> Pass</label>
        <label class="status-opt"><input type="radio" name="status-${item.id}" value="fail" ${status === 'fail' ? 'checked' : ''}> Fail</label>
        <label class="status-opt"><input type="radio" name="status-${item.id}" value="na" ${status === 'na' ? 'checked' : ''}> N/A</label>
      </div>
      <textarea class="notes-input" placeholder="Notes (optional)">${escapeHtml(notes)}</textarea>
    </div>
  `;
}

function showSubmitSuccess(siteId, deficiencies) {
  render(`
    <div class="screen">
      <h1>Submitted</h1>
      <p>Inspection recorded${deficiencies.length ? ` — ${deficiencies.length} deficiency${deficiencies.length > 1 ? 'ies' : 'y'} logged.` : ' — no deficiencies found.'}</p>
      <button id="done-btn">Back to Assets</button>
    </div>
  `);
  document.getElementById('done-btn').addEventListener('click', () => showAssetPicker(siteId));
}

// ---- upload with retry (photos/signature are small, retry aggressively) ----

async function uploadWithRetry(path, contentType, blobOrFile, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await api(path, { method: 'POST', headers: { 'Content-Type': contentType }, body: blobOrFile });
      if (res.status === 201) {
        const data = await res.json();
        return data.key;
      }
      lastErr = new Error(`Upload failed (${res.status})`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  throw lastErr;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  currentUser = null;
  showLogin();
}

// ---- boot ----

async function boot() {
  const { res, data } = await apiJson('/api/auth/me');
  if (res.status === 200) {
    currentUser = data.user;
    showSitePicker();
  } else {
    showLogin();
  }
}

boot();
