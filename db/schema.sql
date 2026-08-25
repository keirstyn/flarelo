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

-- failed_login_count / locked_until back the basic login rate limiting
-- in Phase 2 — after too many wrong passwords in a row, the account is
-- locked out for a fixed window rather than allowed unlimited guesses.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'technician')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'active')) DEFAULT 'invited',
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
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
