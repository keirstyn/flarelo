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

## Running this

Open this repo in **GitHub Codespaces**, then:

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in real values if testing Stripe/Resend
npm test                          # confirms Phase 0-2 tests pass
npm run dev                       # wrangler dev, for anything needing real debugging
```

Deploys go through Cloudflare's Workers Builds Git integration
(dashboard, connect repo, done) — no CLI, no Actions required.

## Next: Phase 3

Sites (CRUD), assets (per-site, with `asset_type`/`interval_days`/
`next_due_at` computed on create and after each inspection), and the
dashboard: one indexed query on `(company_id, next_due_at)` for assets
due within 30 days, grouped by site.
