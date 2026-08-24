import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('health check', () => {
  it('responds on /health', async () => {
    const res = await SELF.fetch('https://example.com/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});

// Cross-account isolation harness — shape only, for now.
//
// This is the project's stand-in for Postgres RLS (D1 has none), so
// per the working agreement it has to exist and pass before any other
// feature is considered done. The shape: seed two companies, A and B,
// each with one user. Authenticate as company A's user, then hit every
// endpoint that takes an id, passing one of company B's ids. Every one
// of those calls must return 403 or 404 — never a 500, and never a 200
// carrying company B's data.
//
// Fill in seeding + real assertions as each endpoint below gets built,
// starting in Phase 1. Add one it.todo() per new endpoint as it's
// added, so the gap between "endpoint exists" and "isolation test
// covers it" never has a chance to grow.
describe('cross-account isolation', () => {
  it.todo('seeds company A and company B with one user each');
  it.todo(
    "returns 403/404 (never 500, never real data) when company A's " +
      "user reads one of company B's sites"
  );
  it.todo(
    "returns 403/404 (never 500, never real data) when company A's " +
      "user reads one of company B's assets"
  );
  it.todo(
    "returns 403/404 (never 500, never real data) when company A's " +
      "user reads one of company B's inspections"
  );
});
