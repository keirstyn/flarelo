-- Flarelo D1 schema.
--
-- Paste this whole file into the Cloudflare dashboard's D1 Console tab
-- (Workers & Pages -> D1 -> your database -> Console) to create the
-- tables. This is intentionally NOT run through `wrangler d1
-- migrations` — see "Dev environment" in docs/flarelo-build-prompt.md
-- for why. A /migrations folder can replace this file later if the
-- project ends up living in Codespaces enough for that tooling to be
-- worth the switch.
--
-- D1 has no Row-Level Security. Every table below except `companies`
-- itself carries a `company_id` column, even where it's derivable
-- through a join — see src/db/withCompanyScope.js, which is the only
-- code allowed to touch these tables directly.
CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- role: owner manages users/billing/sites/assets. office does
-- everything technician can plus site/asset management and deficiency
-- follow-up, but no billing/user management. technician creates/edits
-- their own inspections and views the dashboard only.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  role TEXT NOT NULL CHECK (role IN ('owner', 'technician', 'office')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'active')) DEFAULT 'invited',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_users_company ON users(company_id);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
-- contact_name/contact_email/contact_phone: the site's customer
-- contact, used for the (currently placeholder, full version is
-- Phase 6) post-inspection notification email. All nullable — not
-- every site has a contact on file yet.
CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  address TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sites_company ON sites(company_id);
-- asset_type is a fixed four-value enum by design — see the hard
-- constraint against a custom-type builder in the build prompt.
--
-- interval_days is set by the company, per asset, at their own
-- discretion. Do NOT add a lookup table or default mapping from
-- asset_type/state/NFPA code to an interval here or anywhere else —
-- that is a deliberate liability boundary, not a missing feature.
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  asset_type TEXT NOT NULL CHECK (
    asset_type IN ('fire_extinguisher', 'alarm_system', 'sprinkler_system', 'kitchen_suppression')
  ),
  label TEXT NOT NULL,
  install_date INTEGER,
  interval_days INTEGER NOT NULL,
  next_due_at INTEGER NOT NULL,
  last_inspected_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_assets_company_site ON assets(company_id, site_id);
-- Powers the dashboard: "assets due within 30 days, grouped by site"
-- as one indexed query, per the build prompt.
CREATE INDEX idx_assets_company_next_due ON assets(company_id, next_due_at);
CREATE TABLE inspections (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  technician_user_id TEXT NOT NULL REFERENCES users(id),
  checklist_json TEXT NOT NULL,
  photo_r2_keys TEXT,
  signature_r2_key TEXT,
  pdf_r2_key TEXT,
  next_due_at_snapshot INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL
);
CREATE INDEX idx_inspections_company ON inspections(company_id);
CREATE INDEX idx_inspections_asset ON inspections(asset_id);
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL
);
-- Shared table for both invite links and password-reset links,
-- distinguished by `type`. Single-use: consumeAuthToken() checks
-- used_at IS NULL and sets it in the same read-then-write call. See
-- src/auth/tokens.js.
CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('invite', 'password_reset')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_tokens_user ON auth_tokens(user_id);
-- A deficiency is auto-created for every checklist answer with
-- status 'fail' at submit time (see handleSubmitInspection). This is
-- the one mutable record in the audit trail — status moves
-- open -> quoted -> resolved as the office works the follow-up. The
-- inspection and its PDF that the deficiency came from are never
-- edited; corrections are new records, not overwrites.
CREATE TABLE deficiencies (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  inspection_id TEXT NOT NULL REFERENCES inspections(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  checklist_item_id TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'quoted', 'resolved')) DEFAULT 'open',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX idx_deficiencies_company_status ON deficiencies(company_id, status);
CREATE INDEX idx_deficiencies_inspection ON deficiencies(inspection_id);
CREATE INDEX idx_deficiencies_asset ON deficiencies(asset_id);
-- A configurable, editable definition of "what to check" — the
-- intended eventual replacement for the hardcoded CHECKLISTS object
-- in src/lib/checklists.js. Scoped per-company: each company owns and
-- can eventually edit its own templates rather than sharing one
-- Flarelo-wide definition. No content is seeded here — this is schema
-- only. Real checklist content must come from a qualified
-- professional, not from this design pass.
CREATE TABLE checklist_templates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  asset_type TEXT NOT NULL CHECK (
    asset_type IN ('fire_extinguisher', 'alarm_system', 'sprinkler_system', 'kitchen_suppression')
  ),
  name TEXT NOT NULL,
  -- Freeform label the company chooses (e.g. "Monthly Visual",
  -- "Annual Maintenance") — NOT a hardcoded interval. The asset's own
  -- interval_days still governs scheduling exactly as it does today;
  -- this is descriptive only, so a company can maintain more than one
  -- checklist per asset_type for different kinds of visits.
  frequency_label TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_checklist_templates_company_type ON checklist_templates(company_id, asset_type);
-- Individual line items within a template. applies_to distinguishes
-- system-level items (answered once per inspection, same as today's
-- flat checklist) from component-level items (answered once per
-- individual device — see asset_components below).
CREATE TABLE checklist_template_items (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  checklist_template_id TEXT NOT NULL REFERENCES checklist_templates(id),
  item_key TEXT NOT NULL,
  label TEXT NOT NULL,
  applies_to TEXT NOT NULL CHECK (applies_to IN ('system', 'component')),
  -- Only meaningful when applies_to = 'component' — which kind of
  -- device this item is relevant to (e.g. 'smoke_detector'). NULL for
  -- system-level items.
  component_type TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_checklist_items_template ON checklist_template_items(checklist_template_id);
-- An individual physical device/component belonging to a system-type
-- asset (e.g. one specific smoke detector within an alarm_system
-- asset). component_type is intentionally freeform text, not a fixed
-- enum — unlike the four top-level asset types (which are a hard
-- constraint), real device taxonomies vary too much by manufacturer
-- and system to hardcode a fixed list here. An asset with zero
-- components (e.g. every fire_extinguisher) behaves exactly as it
-- does today — this table is purely additive.
CREATE TABLE asset_components (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  component_type TEXT NOT NULL,
  label TEXT NOT NULL,
  location_note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_asset_components_asset ON asset_components(asset_id);
-- Per-component results for one inspection visit. One inspections row
-- is still one visit / one PDF / one next_due_at update, exactly as
-- today — this table holds the additional per-device detail for
-- systems that have components. results_json mirrors the existing
-- inspections.checklist_json pattern (same shape, same reasoning) —
-- deliberately not a fully normalized answers table, to stay
-- consistent with how system-level answers already work.
CREATE TABLE inspection_component_results (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  inspection_id TEXT NOT NULL REFERENCES inspections(id),
  asset_component_id TEXT NOT NULL REFERENCES asset_components(id),
  results_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_inspection_component_results_inspection ON inspection_component_results(inspection_id);
CREATE INDEX idx_inspection_component_results_component ON inspection_component_results(asset_component_id);
-- Two additive columns on EXISTING tables — both nullable, both
-- backward compatible with every row that already exists.
--
-- inspections.checklist_template_id: which template governed this
-- specific visit, frozen at submit time — so editing a template later
-- never rewrites what an old inspection says it checked. NULL for any
-- inspection submitted before templates exist (all of them, today).
ALTER TABLE inspections ADD COLUMN checklist_template_id TEXT REFERENCES checklist_templates(id);
-- deficiencies.asset_component_id: lets a deficiency point at a
-- specific device instead of just the system as a whole. NULL means
-- "system-level deficiency", exactly today's behavior — fully
-- backward compatible with every deficiency that already exists.
ALTER TABLE deficiencies ADD COLUMN asset_component_id TEXT REFERENCES asset_components(id);
