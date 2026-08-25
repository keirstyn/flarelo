import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import schemaSql from '../db/schema.sql?raw';
import { withCompanyScope } from '../src/db/withCompanyScope.js';

// Strips full-line `--` comments, then splits the rest into individual
// statements on `;`. Good enough for schema.sql as long as it stays in
// the "each statement ends with a semicolon on its own" shape it's in
// today — this is test plumbing, not a general SQL parser.
function parseStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

beforeAll(async () => {
  const statements = parseStatements(schemaSql);
  await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
});

describe('withCompanyScope', () => {
  it('insert forces company_id regardless of what was passed in', async () => {
    const scopeA = withCompanyScope(env.DB, 'company-a');
    await scopeA.insert('companies', { id: 'company-a', name: 'A Co', created_at: Date.now() });
    await scopeA.insert('sites', {
      id: 'site-1',
      company_id: 'should-be-overwritten',
      name: 'Main St',
      created_at: Date.now(),
    });

    const site = await scopeA.findById('sites', 'site-1');
    expect(site.company_id).toBe('company-a');
  });

  it('findById returns null for a row belonging to another company', async () => {
    const scopeA = withCompanyScope(env.DB, 'company-a');
    const scopeB = withCompanyScope(env.DB, 'company-b');
    await scopeB.insert('companies', { id: 'company-b', name: 'B Co', created_at: Date.now() });
    await scopeB.insert('sites', { id: 'site-2', name: 'Elm St', created_at: Date.now() });

    // Company A reaching for company B's site id — this is the
    // cross-account isolation boundary in miniature.
    const crossCompanyResult = await scopeA.findById('sites', 'site-2');
    expect(crossCompanyResult).toBeNull();

    const ownResult = await scopeB.findById('sites', 'site-2');
    expect(ownResult).not.toBeNull();
    expect(ownResult.name).toBe('Elm St');
  });

  it('update across companies is a no-op, not a cross-company write', async () => {
    const scopeA = withCompanyScope(env.DB, 'company-a');
    const scopeB = withCompanyScope(env.DB, 'company-b');

    const result = await scopeA.update('sites', 'site-2', { name: 'Hijacked' });
    expect(result.meta.changes).toBe(0);

    const stillOwnedByB = await scopeB.findById('sites', 'site-2');
    expect(stillOwnedByB.name).toBe('Elm St');
  });

  it('findAll never returns another company\'s rows', async () => {
    const scopeA = withCompanyScope(env.DB, 'company-a');
    const result = await scopeA.findAll('sites');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every((row) => row.company_id === 'company-a')).toBe(true);
  });

  it('remove across companies is a no-op', async () => {
    const scopeA = withCompanyScope(env.DB, 'company-a');
    const scopeB = withCompanyScope(env.DB, 'company-b');

    const result = await scopeA.remove('sites', 'site-2');
    expect(result.meta.changes).toBe(0);

    const stillThere = await scopeB.findById('sites', 'site-2');
    expect(stillThere).not.toBeNull();
  });
});
