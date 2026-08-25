# Flarelo

Fire & life-safety inspection tracker. The full plan, phase-by-phase, lives
in [`docs/flarelo-build-prompt.md`](docs/flarelo-build-prompt.md) — read
that before touching anything here, it's the spec.

## Phase 0 status: done

- `wrangler.jsonc` — Worker config, static assets wired.
- `src/index.js` — `/health` endpoint + static asset fallback.
- `test/isolation.test.js` — a real health-check test, plus the shape of
  the cross-account isolation harness at the HTTP layer (`it.todo(...)`
  per endpoint, filled in starting Phase 3 once real routes exist).
- `vitest.config.js` — runs tests against the actual Workers runtime via
  `@cloudflare/vitest-pool-workers`.

## Phase 1 status: done

- `db/schema.sql` — full schema: `companies`, `users` (with `status`),
  `sessions`, `sites`, `assets`, `inspections`, `stripe_events`. Every
  table but `companies` carries `company_id`, per the hard constraint —
  D1 has no Row-Level Security, so this is the substitute.
- `src/db/withCompanyScope.js` — the one sanctioned way route handlers
  will touch the database from Phase 2 onward. Forces `company_id` on
  every insert, scopes every read/update/delete to it, and turns a
  cross-company lookup into a 404-shaped `null`/no-op instead of a leak.
- `test/withCompanyScope.test.js` — exercises the helper directly
  against a real (local) D1 instance: insert forces the right
  `company_id`, cross-company reads return nothing, cross-company
  updates/deletes are no-ops, `findAll` never leaks another company's
  rows.
- `wrangler.jsonc` now has a live `DB` binding (D1) with a placeholder
  `database_id` — swap it for the real one once you've created the
  database in the Cloudflare dashboard (see below).

### Setting up the real D1 database

1. Cloudflare dashboard → Workers & Pages → D1 → **Create database** →
   name it `flarelo-db`.
2. Copy its Database ID, paste it into `wrangler.jsonc` in place of the
   placeholder `00000000-...` value.
3. Open the new database → **Console** tab → paste in the entire
   contents of `db/schema.sql` → run it. This creates all seven tables
   in the real, deployed database.
4. `npm test` and `npm run dev` work fine even before you do this step
   — they use a local D1 instance. It only matters for `wrangler deploy`.

## Running this

No local terminal needed for anything except actual development — see
"Dev environment" in the build prompt for the full breakdown. Short
version: open this repo in **GitHub Codespaces**, then:

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in real values if testing Stripe/Resend
npm test                          # confirms Phase 0 + Phase 1 tests pass
npm run dev                       # wrangler dev, for anything needing real debugging
```

Deploys go through Cloudflare's Workers Builds Git integration
(dashboard, connect repo, done) — no CLI, no Actions required.

## Next: Phase 2

Auth: signup (owner, active), invite flow (technician, invited →
active), PBKDF2 password hashing via `crypto.subtle`, sessions via
httpOnly/Secure/SameSite=Lax cookies, role-based middleware, password
reset, login rate limiting, and a bare-minimum `sendEmail` helper that
Phase 6 later expands.
