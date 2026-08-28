-- Flarelo D1 schema — Phase 1.
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
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  role TEXT NOT NULL CHECK (role IN ('owner', 'technician')),
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
CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  address TEXT,
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
-- Powers the Phase 3 dashboard: "assets due within 30 days, grouped by
-- site" as one indexed query, per the build prompt.
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
-- Phase 4 extension: deficiencies + site contact info.
-- Contact info for the site's customer, used for the (currently
-- placeholder, full version is Phase 6) post-inspection notification
-- email. All nullable — not every site has a contact on file yet.
ALTER TABLE sites ADD COLUMN contact_name TEXT;
ALTER TABLE sites ADD COLUMN contact_email TEXT;
ALTER TABLE sites ADD COLUMN contact_phone TEXT;
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
-- Adds the 'office' role. CORRECTED ordering vs. an earlier version of
-- this migration: SQLite's ALTER TABLE ... RENAME automatically
-- rewrites OTHER tables' foreign-key text to point at the new name —
-- so renaming users -> users_old first (then later creating a fresh
-- table literally named `users`) leaves sessions/auth_tokens/
-- inspections still pointing at the now-deleted `users_old`, breaking
-- every INSERT into any of them. This version creates the replacement
-- under a temp name, drops the original, then renames the temp into
-- place — by the time the rename happens nothing references the temp
-- name, so there's nothing to rewrite, and everything ends up
-- pointing at the real `users` table. Reproduced the old bug and
-- verified this ordering against real SQLite (including an actual
-- INSERT into sessions afterward, not just a JOIN) before shipping.
-- Safe to run whether real user rows already exist or not.
PRAGMA foreign_keys=OFF;
CREATE TABLE users_new (
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
INSERT INTO users_new (id, company_id, email, password_hash, failed_login_count, locked_until, role, status, created_at)
SELECT id, company_id, email, password_hash, failed_login_count, locked_until, role, status, created_at
FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX idx_users_company ON users(company_id);
PRAGMA foreign_keys=ON;
