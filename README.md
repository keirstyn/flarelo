# Flarelo

Fire & life-safety inspection tracker. The full plan, phase-by-phase, lives
in [`docs/flarelo-build-prompt.md`](docs/flarelo-build-prompt.md) — read
that before touching anything here, it's the spec.

## Phase 0 status: done

- `wrangler.jsonc` — Worker config, static assets wired, D1/R2 bindings
  stubbed until those resources exist in the dashboard.
- `src/index.js` — `/health` endpoint + static asset fallback.
- `test/isolation.test.js` — a real health-check test, plus the shape of
  the cross-account isolation harness (`it.todo(...)` per endpoint,
  filled in as each one is built).
- `vitest.config.js` — runs tests against the actual Workers runtime via
  `@cloudflare/vitest-pool-workers`.

## Running this

No local terminal needed for anything except actual development — see
"Dev environment" in the build prompt for the full breakdown. Short
version: open this repo in **GitHub Codespaces**, then:

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in real values if testing Stripe/Resend
npm test                          # confirms the health check passes
npm run dev                       # wrangler dev, for anything needing real debugging
```

Deploys go through Cloudflare's Workers Builds Git integration
(dashboard, connect repo, done) — no CLI, no Actions required.

## Next: Phase 1

Schema (`companies`, `users` with `status`, `sessions`, `sites`,
`assets`, `inspections`, `stripe_events`) pasted into D1's Console tab,
plus `withCompanyScope` — every later phase calls it, nothing else
touches `env.DB` directly.
