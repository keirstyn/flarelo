# Flarelo — Project Handoff

Read this file AND `docs/flarelo-build-prompt.md` before doing anything.
The build prompt is the spec and the rules (hard constraints, build
order, what NOT to build). This file is the current state: what's
actually done, verified, and the specific things that went wrong along
the way — so they don't go wrong again.

If you're a fresh AI picking this up with no other context: the person
you're talking to is non-technical-ish but capable — they've been
pasting shell scripts into a GitHub Codespace terminal and reading
`npm test` output back as screenshots. They do not have a local
terminal. Assume that workflow continues.

## What this is

Flarelo: a fire & life-safety inspection tracker for small
testing/service companies. Cloudflare Workers + D1 + R2 + Resend +
Stripe. One company per account. Full spec is
`docs/flarelo-build-prompt.md` — it has hard constraints that must not
be violated without asking first (no ORM, no client login portal, no
hardcoded NFPA intervals, D1 has no RLS so `withCompanyScope` is
mandatory, etc.) and a phase-by-phase build order that must not be
skipped ahead of.

## Status: Phases 0-3 done and verified. Phase 4 not started.

- **Phase 0** — repo scaffold, `/health` endpoint, isolation test
  harness shape. Done.
- **Phase 1** — full D1 schema (`companies`, `users`, `sessions`,
  `sites`, `assets`, `inspections`, `stripe_events`, `auth_tokens`),
  `withCompanyScope` helper. Done, tested.
- **Phase 2** — full auth: signup, login (with lockout), logout,
  invite, accept-invite, password-reset request + reset. Done, tested.
- **Phase 3** — sites CRUD, assets CRUD (with `next_due_at`
  computation), dashboard (`(company_id, next_due_at)` windowed
  query, grouped by site). Built during a period the primary AI
  assistant was unavailable, then synced into this handoff and
  independently re-verified (33 separate checks against a simulated
  DB, including real cross-company isolation) — all passed, and the
  user separately confirmed `npm test` passes for real. Done.
- **Phase 4 (next)** — inspection form + PDF. Not started.

Real D1 database has NOT been created in the Cloudflare dashboard yet
— `wrangler.jsonc` still has a placeholder `database_id`. Local
`npm test` / `npm run dev` work fine regardless (local D1 doesn't care
about the ID); only `wrangler deploy` needs the real one. Same for
`RESEND_API_KEY` — not set anywhere real yet, so invite/reset emails
will fail in an actual deployed environment until that's configured in
the Cloudflare dashboard secrets.

## Repo structure

```
wrangler.jsonc          Worker config. D1 binding present (placeholder ID).
package.json            wrangler, vitest, @cloudflare/vitest-pool-workers
vitest.config.js         wired to the Workers test pool
.dev.vars.example       template for local secrets (RESEND_API_KEY etc.)
db/schema.sql            paste into D1 dashboard Console tab (NOT wrangler migrations — deliberate, see build prompt)
docs/flarelo-build-prompt.md   the spec — read this first
src/index.js              router (hand-rolled, :param matching) — all routes
src/db/withCompanyScope.js   the only sanctioned way to touch D1 (one exception: companies table itself)
src/auth/
  passwords.js            PBKDF2 hash/verify via crypto.subtle
  sessions.js              create/validate/destroy session, cookie helpers
  tokens.js                 invite + password-reset tokens (shared auth_tokens table, single-use)
  middleware.js            authenticate() + requireRole()
src/lib/
  crypto-utils.js          shared token/hash primitives
  email.js                 sendEmail() via Resend REST API
  http.js                    tiny json()/readJson() helpers
src/routes/
  auth.js                    all seven auth route handlers
  sites.js                    site CRUD, owner-only writes
  assets.js                   asset CRUD, next_due_at computation, owner-only writes
  dashboard.js                (company_id, next_due_at) windowed query, grouped by site
test/
  isolation.test.js         health check + cross-account isolation (real assertions as of Phase 3; inspections case still it.todo, waiting on Phase 4)
  withCompanyScope.test.js  Phase 1 helper tests
  auth.test.js               signup/login/lockout/session/logout tests
  auth-invite-reset.test.js  invite/accept/reset tests
  sites-assets-dashboard.test.js  Phase 3: CRUD, role enforcement, next_due_at, validation, deletion guards, dashboard windowing/grouping/ordering
```

## Design decisions worth knowing (not obvious from reading one file)

- **`withCompanyScope` has one exception: the `companies` table
  itself.** It has no `company_id` column (can't be scoped to itself),
  so creating a company uses a plain `env.DB.prepare(...).run()`
  insert. This bit us once already (Phase 1 test bug) — the comment at
  the top of `src/db/withCompanyScope.js` explains it; don't remove
  that comment.
- **PBKDF2 iteration count is 100,000, not OWASP's recommended
  600,000.** Deliberate tradeoff for Workers CPU-time limits, not an
  oversight — see the comment in `src/auth/passwords.js`. Revisit
  upward once there's real production CPU-time data.
- **`sendEmail` is dependency-injected.** `handleInvite` and
  `handleRequestPasswordReset` take a third parameter
  `{ sendEmailFn = sendEmail }` — in production (called via the router)
  this is always the real Resend-calling function; in tests, a fake
  recorder is passed in instead, so tests never hit the real network or
  need a real API key. If you add more email-sending routes, follow
  this same pattern rather than mocking global `fetch`.
- **`auth_tokens` is one shared table for both invites and password
  resets**, distinguished by a `type` column. Single-use is enforced by
  checking `used_at IS NULL` and setting it in the same
  read-then-write call (`consumeAuthToken` in `src/auth/tokens.js`).
- **Login returns the same generic 401 for wrong password, unknown
  email, AND a not-yet-activated account** — deliberately
  indistinguishable from outside.
- **Password reset request always returns 200** regardless of whether
  the email exists, and is rate-limited to one email per 5 minutes per
  account (checked via a query on `auth_tokens`, not a separate rate
  limit table).
- **The router (`src/index.js`) is hand-rolled**, no framework —
  matches `:param` segments by splitting on `/` and comparing segment
  counts, so e.g. `/api/sites/:id` (3 segments) and
  `/api/sites/:siteId/assets` (4 segments) never collide regardless of
  declaration order. Every handler's signature is
  `(request, env, ctx, params)` — auth-only routes ignore the trailing
  two args, sites/assets routes use `params` for the id(s).
- **Sites/assets write operations (create/update/delete) are
  owner-only; reads (list/get) are open to any authenticated user.**
  Same reasoning as user/billing management in the build prompt — a
  technician needs to see where they're going but doesn't configure
  company setup.
- **Deleting a site with assets, or an asset with inspection history,
  is refused (`409`) rather than cascading.** The asset-with-
  inspections check can't actually trigger yet (Phase 4 doesn't exist),
  but it's in place now so Phase 4 doesn't have to remember to add it.

## The specific mistakes made this session (so they aren't repeated)

1. **`@cloudflare/vitest-pool-workers` isolates storage PER TEST, not
   per file.** Whatever one `it()` block inserts is gone by the time
   the next `it()` block runs. Schema creation belongs in `beforeAll`
   (survives, since it runs before isolation kicks in); row data has to
   be re-seeded in `beforeEach` or inline within each test. This caused
   a real test failure in Phase 1 (`test/withCompanyScope.test.js`)
   before being fixed. Every test file since follows the
   seed-per-test/per-`beforeEach` pattern — keep doing that.
2. **GitHub's drag-and-drop web upload does not reliably preserve
   nested folder structure.** Uploading a `src/` folder this way turned
   it into a single 0-byte file named `src`. Reliable methods that
   worked: (a) paste a heredoc-based shell script directly into the
   Codespace terminal (`cat > path/to/file << 'EOF' ... EOF`, repeated
   per file), or (b) GitHub's "Add file → Create new file" web page,
   typing the full path (e.g. `src/index.js`) into the filename field.
3. **The person is on a Chromebook.** Plain `Ctrl+V` often doesn't
   paste into the Codespace's browser-based terminal — `Ctrl+Shift+V`
   works. If that still fails, the GitHub web file-editor textarea
   (method b above) accepts normal paste with no issue, since it's not
   a terminal emulator.
4. **`wrangler.jsonc`'s `compatibility_date` must be a date the
   installed Workers runtime actually recognizes** — an
   auto-generated future date caused a silent fallback warning. Keep it
   pinned to a real, current, supported date rather than "today."
5. Every multi-file drop so far has been delivered as ONE paste-able
   shell script (`cat > file << 'FLARELO_EOF' ... FLARELO_EOF`,
   repeated per file, all in a single code block) rather than asking
   the person to run several separate commands — that pattern has
   worked reliably once they know to paste the whole block at once.
   Keep using it for future phases.

## How code has been verified before handing it to the user

Every phase's code was actually executed against a simulated database
in a sandbox before being handed over — not just syntax-checked. The
pattern: a small `FakeD1` class wrapping Node's built-in `node:sqlite`
(`DatabaseSync`), matching D1's `.prepare().bind().run()/.all()/
.first()` + `.batch()` shape, with the real `schema.sql` executed
against it. Real route handler functions were then imported and called
directly with real `Request`/`Response` objects (both are Node
built-in globals, matching the Workers runtime closely enough) and a
`{ DB: fakeD1Instance }` env object. This caught real bugs (e.g. the
`companies`-table `withCompanyScope` misuse) before the user ever ran
`npm test`. If continuing this project, keep doing this for
non-trivial logic before handing code over — it has a much better hit
rate than syntax-checking alone. The actual shipped test files
(`test/*.test.js`) are separate from this — they run for real via
`@cloudflare/vitest-pool-workers`, which this sandbox cannot execute
directly (no network to install packages), so the Node-based
simulation is the pre-check, not a replacement for the real test run.

## What's next: Phase 4

Per the build prompt: mobile-friendly inspection form (four hardcoded
checklists as static JSON per asset type, photo upload via a signed R2
upload URL, live signature capture on a canvas pad — never pre-filled
or reused), submit flow (generate the PDF, store it in R2, update
`assets.next_due_at`/`last_inspected_at`, write the `inspections` row
with a snapshot of the computed next-due date). Before the real PDF
template: a 10-minute "hello world" PDF with `pdf-lib` inside an
actually-deployed Worker (not just local dev) to confirm it runs
cleanly — Workers isn't full Node and some packages hit compatibility
walls; fall back to Cloudflare's Browser Rendering binding only if
`pdf-lib` can't do the layout. Needs the `r2_buckets` binding in
`wrangler.jsonc` uncommented and a real R2 bucket created to match.
This is also the phase that can finally fill in the `inspections`
cross-account-isolation `it.todo` in `test/isolation.test.js`.
