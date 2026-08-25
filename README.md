# Flarelo

Fire & life-safety inspection tracker. The full plan, phase-by-phase, lives
in [`docs/flarelo-build-prompt.md`](docs/flarelo-build-prompt.md) — read
that before touching anything here, it's the spec.

## Phase 0 status: done

- `wrangler.jsonc` — Worker config, static assets wired.
- `src/index.js` — routes to auth handlers, plus `/health` and a static
  asset fallback.
- `test/isolation.test.js` — a real health-check test, plus the shape of
  the cross-account isolation harness at the HTTP layer (`it.todo(...)`
  per endpoint, filled in starting Phase 3 once real routes exist).
- `vitest.config.js` — runs tests against the actual Workers runtime via
  `@cloudflare/vitest-pool-workers`.

## Phase 1 status: done

- `db/schema.sql` — full schema: `companies`, `users`, `sessions`,
  `sites`, `assets`, `inspections`, `stripe_events`, `auth_tokens`.
  Every table but `companies` carries `company_id`, per the hard
  constraint — D1 has no Row-Level Security, so this is the substitute.
- `src/db/withCompanyScope.js` — the one sanctioned way route handlers
  touch the database. Forces `company_id` on every insert, scopes every
  read/update/delete to it, and turns a cross-company lookup into a
  404-shaped `null`/no-op instead of a leak. One exception: `companies`
  itself is created with a plain `env.DB` insert — see the comment in
  that file.
- `test/withCompanyScope.test.js` — exercises the helper directly
  against a real (local) D1 instance.

## Phase 2 status: done

- **Signup** (`POST /api/auth/signup`) — creates a company + first
  user, role `owner`, status `active`. The only way a company gets
  created.
- **Login** (`POST /api/auth/login`) — PBKDF2 (via `crypto.subtle`) +
  session cookie (httpOnly/Secure/SameSite=Lax). Same generic error for
  wrong password / unknown email / not-yet-active account, so none of
  those are distinguishable from outside. Locks an account for 15
  minutes after 5 failed attempts in a row.
- **Logout** (`POST /api/auth/logout`).
- **Invite** (`POST /api/auth/invite`, owner-only) — creates a
  `status: invited` user scoped to the owner's company, emails a
  signed, expiring (7-day) link via Resend. Defaults to `technician`
  role unless the owner specifies `owner`.
- **Accept invite** (`POST /api/auth/accept-invite`) — sets a password,
  flips the user to `status: active`, logs them in. Single-use token.
- **Request password reset** (`POST /api/auth/request-password-reset`)
  — always returns 200 regardless of whether the email exists (no
  account enumeration), and sends at most one email per 5 minutes per
  account.
- **Reset password** (`POST /api/auth/reset-password`) — single-use,
  1-hour-expiring token.
- `src/auth/` — `passwords.js` (PBKDF2 hash/verify), `sessions.js`
  (create/validate/destroy, cookie helpers), `tokens.js` (invite +
  reset tokens, single-use), `middleware.js` (`authenticate()` +
  `requireRole()` — every future protected route goes through these).
- `src/lib/email.js` — bare-minimum `sendEmail()` via Resend's REST
  API. Phase 6 expands this into the full client-facing PDF email with
  SPF/DKIM verification.
- `test/auth.test.js` + `test/auth-invite-reset.test.js` — cover
  signup, login, lockout, session middleware, logout, invite,
  accept-invite (incl. single-use), password-reset request (incl.
  rate-limiting and no email-enumeration), and reset (incl. single-use).
  The invite/reset tests inject a fake `sendEmail` so they run with no
  real network calls and no real Resend API key.

### Before this goes to production

- Set `RESEND_API_KEY` (and optionally `EMAIL_FROM` once you have a
  verified sending domain) as Cloudflare dashboard secrets — see
  `.dev.vars.example` for the full list. Without a real
  `RESEND_API_KEY`, invite/reset emails will fail in production
  (they're intentionally NOT best-effort — see the comment in
  `src/lib/email.js`).
- `src/lib/email.js` defaults to Resend's `onboarding@resend.dev`
  sandbox sender, which only delivers to the Resend account's own
  address. Replace with a real domain-verified sender before real
  users rely on invites/resets arriving.

### Setting up the real D1 database

1. Cloudflare dashboard → Workers & Pages → D1 → **Create database** →
   name it `flarelo-db`.
2. Copy its Database ID, paste it into `wrangler.jsonc` in place of the
   placeholder `00000000-...` value.
3. Open the new database → **Console** tab → paste in the entire
   contents of `db/schema.sql` → run it.
4. `npm test` and `npm run dev` work fine even before you do this step
   — they use a local D1 instance. It only matters for `wrangler deploy`.

## Phase 3 status: done

- **Sites** (`POST/GET /api/sites`, `GET/PATCH/DELETE /api/sites/:id`) —
  plain CRUD, scoped to the caller's company via `withCompanyScope`.
  Creating/editing/deleting a site is owner-only (company setup, same
  as user/billing management); listing and reading are open to any
  authenticated user, since a technician needs to see where they're
  going. `GET /api/sites/:id` also returns that site's assets.
  Deleting a site with assets still on it is refused (`409`) rather
  than cascading — remove/reassign the assets first.
- **Assets** (`POST/GET /api/sites/:siteId/assets`,
  `GET/PATCH/DELETE /api/assets/:id`) — same owner-only-for-writes /
  open-for-reads split as sites. `asset_type` is validated against the
  fixed four-value enum before it ever reaches the DB's `CHECK`
  constraint. `next_due_at` is computed on create: an explicit
  `next_due_at` in the request wins, otherwise it's
  `install_date` (or "now", if no `install_date` given) plus one
  `interval_days` — never a hardcoded NFPA/state-code interval, per
  the hard constraint. Deleting an asset with inspection history is
  refused (`409`); nothing can trip that yet since Phase 4 doesn't
  exist, but the check is in place so Phase 4 doesn't have to
  remember to add it.
- **Dashboard** (`GET /api/dashboard?days=30`) — one indexed query on
  `(company_id, next_due_at)` (see `idx_assets_company_next_due` in
  `db/schema.sql`) for every asset due within the window, including
  anything already overdue. Grouped by site in JS after the single
  query, not in SQL.
- `test/isolation.test.js` — the cross-account isolation harness now
  has real assertions (seeded companies A/B, company A's session hits
  every sites/assets endpoint with company B's ids) instead of
  `it.todo(...)`. Per the working agreement, this had to pass before
  Phase 3 counted as done. The `inspections` case stays `it.todo`
  until Phase 4 builds that table's routes.
- `test/sites-assets-dashboard.test.js` — CRUD + role enforcement for
  sites and assets, `next_due_at` computation (both computed and
  explicit-override paths), validation errors, the "can't delete
  what's still referenced" guards, and dashboard windowing/grouping/
  ordering.

## Running this

Open this repo in **GitHub Codespaces**, then:

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in real values if testing Stripe/Resend
npm test                          # confirms Phase 0-3 tests pass
npm run dev                       # wrangler dev, for anything needing real debugging
```

Deploys go through Cloudflare's Workers Builds Git integration
(dashboard, connect repo, done) — no CLI, no Actions required.

## Next: Phase 4

Mobile-friendly inspection form (four hardcoded checklists, photo
upload via a signed R2 upload URL, live signature capture — never
pre-filled), submit flow (generate the PDF, store it in R2, update
`assets.next_due_at`/`last_inspected_at`, write the `inspections`
row), and the `pdf-lib` "hello world" smoke test in an actually-
deployed Worker before building the real template. Needs the
`r2_buckets` binding in `wrangler.jsonc` uncommented, and a real R2
bucket created to match.
