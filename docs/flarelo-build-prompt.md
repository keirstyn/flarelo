# Flarelo — Build Prompt for a Coding Agent

Use this as the first message in a fresh repo, with a coding agent that
can actually run and check the code as it goes — a Claude chat with
code execution turned on works well here, since Claude Code locally
isn't an option. It's written as an execution plan, not a restatement
of the spec: highest-risk work first, and it resolves what the
original spec left open — Stripe on Workers, plus the multi-user-login
and offline-handling gaps that only showed up once someone walked
through how a real technician would actually use this.

---

## What you're building

Flarelo: a fire & life-safety inspection tracker for small testing/service
companies (fire extinguishers, alarm systems, sprinkler systems, kitchen
suppression systems). One company per account. A dashboard of what's due,
a mobile inspection form with photo + live signature capture, and an
auto-generated PDF report emailed to the client after each inspection.

## Hard constraints — do not deviate without asking first

- Cloudflare Workers with Static Assets, D1 (SQLite), R2, Resend, Stripe,
  GitHub for version control. No Supabase, no standalone Node server, no
  ORM unless you hit a real wall with raw D1 queries. Deploys go through
  Cloudflare's Workers Builds Git integration by default (see Dev
  environment below) — GitHub Actions is optional, not required.
- USD only, English only. One company = one account, no multi-location
  hierarchy. Four fixed asset types, no custom-type builder. No client
  login portal — clients only ever receive emailed PDFs.
- The company sets its own inspection interval per asset. Do **not**
  hardcode NFPA or state-code-specific intervals anywhere — this is a
  deliberate liability boundary, not a missing feature. Say so in a code
  comment wherever interval logic lives.
- D1 has no Row-Level Security. Every table that isn't `companies` itself
  gets a `company_id` column, denormalized even where it's derivable
  through a join (e.g. on `inspections`). Every query goes through one
  shared `withCompanyScope(db, companyId)` helper — no ad hoc queries in
  route handlers, ever.

## Dev environment — assume no local terminal

Don't assume a local `wrangler` CLI is available. Be honest about what
each option actually gives you — they are not equivalent:

- **GitHub Codespaces** (free tier: ~60 hours/month on a 2-core
  machine) is the only option that gives you a real development loop.
  `wrangler dev`, `npm`, `git`, and the Stripe CLI (for forwarding test
  webhooks to a running Worker) all work exactly as they would locally.
  Use this for any phase that needs actual debugging — which is most
  of them, especially the PDF template and the Stripe webhook handler.
- **Drag-and-drop to GitHub's web UI + Cloudflare's Git integration
  ("Workers Builds")** deploys with zero terminal, but it's a *deploy*
  path, not a *development* path — you're pushing blind and reading
  Workers Builds' logs afterward to find out if it worked. Treat it as
  the way you ship a chunk that's already been written and tested
  elsewhere, not as how you write and debug that chunk.
- A third option that covers the gap between those two: build and test
  a phase inside a Claude chat session first — Claude can actually run
  the code and check it before handing it over — then push only the
  verified result through the web UI above.

Whichever path you use, set secrets (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, the session signing secret)
through the Cloudflare dashboard — Workers & Pages → your Worker →
Settings → Variables and Secrets — instead of `wrangler secret put`.
D1's schema for a first version can likewise be pasted straight into
the database's **Console** tab in the dashboard instead of
`wrangler d1 migrations` — fine for a solo project; move to file-based
migrations later if it starts to hurt.

## Build order — follow this sequence, don't skip ahead for "faster" features

**Phase 0 — repo scaffold + the isolation test harness, before any feature code.**
Stand up `wrangler.jsonc`, a minimal Worker that responds to `/health`,
and a test file that will hold the cross-account isolation test. Keep
the D1 schema as plain SQL you paste into the dashboard's Console tab
for now (see Dev environment above); add a `/migrations` folder later
only if you end up in Codespaces enough for `wrangler d1 migrations`
to be worth the switch. Write the isolation test's *shape* now (two
seeded companies, assert account A gets zero rows and a 403/404 — not
a 500 — when it touches account B's data through any endpoint) even
before the endpoints exist. This test grows with every endpoint you
add from here on.

**Phase 1 — schema + `withCompanyScope`.**
Create `companies`, `users`, `sessions`, `sites`, `assets`, `inspections`,
`stripe_events` per the data model, plus a `status` column (`invited` |
`active`) on `users` — the original schema didn't anticipate a second
person joining a company, which Phase 2's invite flow needs. Write
`withCompanyScope` first; every later phase calls it, nothing else
touches `env.DB` directly.

**Phase 2 — auth.**
Signup (creates `companies` + first `users` row, role `owner`, status
`active`) → session
login using PBKDF2 via Workers' native `crypto.subtle` (no bcrypt/argon2 —
they need native bindings Workers doesn't have) → random session token,
store its hash in `sessions`, httpOnly + Secure + SameSite=Lax cookie,
checked in middleware on every request. A second user never goes
through the public signup form — that form always creates a brand-new
company. Instead: the owner invites a teammate by email from inside the
dashboard, which creates a `users` row (`status: invited`) scoped to
the existing `company_id` and emails a signed, expiring invite link via
Resend; the teammate sets their own password through that link, which
flips the row to `status: active`. Also build password reset (expiring,
single-use, rate-limited token, delivered by email the same way — the
spec didn't call this out explicitly but it needs the same rigor as
login) and basic rate limiting on failed login attempts. Define role
scope now, not later: `owner` can manage users, billing, and sites;
`technician` can create/edit their own inspections and view the
dashboard but can't remove users or touch billing, and defaults to
`technician` when invited unless the owner sets otherwise. Enforce it
in the same middleware that checks the session.
Note the dependency this creates: invite and reset emails need Resend
working *now*, three phases before Phase 6 formally builds it out.
Write a bare-minimum `sendEmail(to, subject, body)` helper here — just
enough to fire those two transactional emails — and let Phase 6 expand
it into the full client-facing PDF email, with SPF/DKIM verification
added at that point.

**Phase 3 — sites, assets, dashboard.**
CRUD for sites. Assets per site with `asset_type`, `label`, `install_date`,
`interval_days`; compute `next_due_at` on create and after each
inspection. Dashboard: one indexed query on `(company_id, next_due_at)`
for assets due within 30 days, grouped by site — this is the screen the
customer opens every morning, keep it to one query.

**Phase 4 — inspection flow + PDF.**
Mobile-friendly form: four hardcoded checklists (static JSON per asset
type), photo upload via a signed R2 upload URL, signature captured live
on a canvas pad at submission time — never pre-filled or reused. Assume
bad signal: technicians fill this out in basements and mechanical
rooms. Keep in-progress form state in local component state (or
`localStorage`-equivalent for the framework you pick) and retry the
submit on failure instead of losing the entered checklist. On
submit: generate the PDF (see below), store it in R2, update
`assets.next_due_at` / `last_inspected_at`, write the `inspections` row
with a snapshot of the computed next-due date.
Before building the real PDF template, spend 10 minutes generating a
"hello world" PDF with `pdf-lib` inside an actually-deployed Worker (not
just `wrangler dev`) to confirm it runs cleanly — Workers isn't full
Node and some packages hit compatibility walls. If `pdf-lib` can't do
the layout, fall back to Cloudflare's Browser Rendering binding, not
before.

**Phase 5 — payments.** See the resolved implementation notes below —
this is where prior attempts likely stalled.

**Phase 6 — email.**
Resend, best-effort: log failures, never block the inspection submission
on the email send succeeding. Verify SPF/DKIM on the sending domain
before relying on this in production — an inspection report silently
landing in spam defeats the entire feature.

**Phase 7 — CI/CD + remaining tests.**
Default to Cloudflare's Workers Builds Git integration (connect the repo
once, by clicking, in the Cloudflare dashboard) for deploys on merge to
`main` — no CLI involved. Add a GitHub Actions workflow on top of it
later only if you want tests to gate the deploy; it's not required to
ship. Webhook idempotency test (simulate Stripe
delivering the same event twice, assert no duplicate processing). PDF
smoke test (fixed input in, assert well-formed output with the
disclaimer text present). Auth test (session required on all non-public
routes, expired/invalid session rejected).

---

## Payments implementation notes — resolved

Stripe's Node SDK **does** work natively in Workers — Cloudflare and
Stripe shipped official support for this back in 2021, and Cloudflare's
Node.js compat layer (`nodejs_compat` / `nodejs_compat_v2`, on by default
for current compatibility dates) covers most of what used to require
manual polyfilling. Two things still need to be explicit, and skipping
either is the most common way this breaks:

```js
// stripeClient.js
import Stripe from 'stripe';

export function getStripe(env) {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    // Workers has no Node `http` module — force the fetch-based client
    httpClient: Stripe.createFetchHttpClient(),
  });
}
```

```js
// webhook handler
export async function handleStripeWebhook(request, env) {
  const stripe = getStripe(env);
  const body = await request.text();     // read the raw body ONCE — read
                                          // it twice and you'll hit "Body
                                          // has already been used"
  const sig = request.headers.get('stripe-signature');

  const event = await stripe.webhooks.constructEventAsync(
    body,
    sig,
    env.STRIPE_WEBHOOK_SECRET,
    undefined,
    Stripe.createSubtleCryptoProvider()  // Workers has no Node
                                          // crypto.createHmac — use the
                                          // async verifier + WebCrypto
                                          // provider, not constructEvent
  );

  const seen = await env.DB
    .prepare('SELECT id FROM stripe_events WHERE id = ?')
    .bind(event.id).first();
  if (seen) return new Response('ok', { status: 200 }); // idempotent no-op

  // switch on event.type: checkout.session.completed,
  // customer.subscription.updated, customer.subscription.deleted,
  // invoice.payment_failed — gate access off on lapse, not just at signup

  await env.DB
    .prepare('INSERT INTO stripe_events (id, processed_at) VALUES (?, ?)')
    .bind(event.id, Date.now()).run();

  return new Response('ok', { status: 200 });
}
```

Never trust a client-side redirect back from Checkout as proof of
payment — real functionality (PDF generation, client emailing, tracking
past the trial cap) unlocks only when this webhook fires and verifies.
Free trial: 10 tracked assets or 14 days, no card required to start.

On `customer.subscription.deleted`, don't delete or lock out historical
data — inspection PDFs are often needed years later for audits or
insurance. Move the account to a read-only state (dashboard and new
inspections blocked, existing PDF history still viewable/downloadable)
rather than hard-deleting anything.

## Legal text — ships in v1, verbatim, on every generated PDF

> This report reflects inspection results entered by the technician on
> [date]. Flarelo does not perform inspections and is not responsible
> for their accuracy.

## Explicitly do NOT build

No AI-assisted checklist suggestions, OCR, or code interpretation — this
app is deterministic by design. No native mobile app. No
multi-location/franchise hierarchy. No client login portal. No custom
checklist builder. No hardcoded state/NFPA interval rules.

## Working agreement

- Comment every scope cut in the code where it applies (interval logic,
  asset types, auth) so it reads as intentional, not incomplete.
- If a request would conflict with a hard constraint above, stop and ask
  rather than quietly expanding scope.
- The cross-account isolation test must exist and pass before any other
  feature is considered done — treat it as the project's equivalent of
  Postgres RLS, because nothing else is enforcing that boundary.
