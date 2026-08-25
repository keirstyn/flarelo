import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import schemaSql from '../db/schema.sql?raw';
import { authenticate } from '../src/auth/middleware.js';

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

function signup(overrides = {}) {
  return SELF.fetch('https://example.com/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      email: 'owner@acme.test',
      password: 'hunter2hunter2',
      companyName: 'Acme Co',
      ...overrides,
    }),
  });
}

function login(overrides = {}) {
  return SELF.fetch('https://example.com/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'owner@acme.test', password: 'hunter2hunter2', ...overrides }),
  });
}

function extractSessionToken(response) {
  const cookie = response.headers.get('Set-Cookie') || '';
  const match = cookie.match(/flarelo_session=([^;]+)/);
  return match ? match[1] : null;
}

describe('auth: signup', () => {
  it('creates a company + owner user and returns a session cookie', async () => {
    const res = await signup();
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.user.role).toBe('owner');

    const cookie = res.headers.get('Set-Cookie');
    expect(cookie).toContain('flarelo_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('rejects a second signup with the same email', async () => {
    await signup();
    const res = await signup({ companyName: 'A Different Co' });
    expect(res.status).toBe(409);
  });

  it('rejects a signup missing required fields', async () => {
    const res = await SELF.fetch('https://example.com/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@acme.test' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('auth: login', () => {
  it('logs in with the correct password', async () => {
    await signup();
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('flarelo_session=');
  });

  it('rejects a wrong password', async () => {
    await signup();
    const res = await login({ password: 'totally wrong' });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown email with the same generic error as a wrong password', async () => {
    const res = await login({ email: 'nobody@acme.test' });
    expect(res.status).toBe(401);
  });

  it('locks the account out after 5 failed attempts, even against the right password', async () => {
    await signup();
    for (let i = 0; i < 5; i++) {
      await login({ password: 'wrong' });
    }
    const res = await login(); // correct password this time
    expect(res.status).toBe(429);
  });
});

describe('auth: session middleware', () => {
  it('authenticate() resolves a valid session cookie to the right user', async () => {
    const signupRes = await signup();
    const token = extractSessionToken(signupRes);
    const authedReq = new Request('https://example.com/api/whatever', {
      headers: { Cookie: `flarelo_session=${token}` },
    });
    const result = await authenticate(authedReq, env);
    expect(result?.user.email).toBe('owner@acme.test');
  });

  it('authenticate() returns null with no cookie', async () => {
    const result = await authenticate(new Request('https://example.com/api/whatever'), env);
    expect(result).toBeNull();
  });

  it('authenticate() returns null for a garbage token', async () => {
    const result = await authenticate(
      new Request('https://example.com/api/whatever', { headers: { Cookie: 'flarelo_session=not-a-real-token' } }),
      env
    );
    expect(result).toBeNull();
  });
});

describe('auth: logout', () => {
  it('clears the cookie and invalidates the session', async () => {
    const signupRes = await signup();
    const token = extractSessionToken(signupRes);

    const logoutRes = await SELF.fetch('https://example.com/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `flarelo_session=${token}` },
    });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.headers.get('Set-Cookie')).toContain('Max-Age=0');

    const result = await authenticate(
      new Request('https://example.com/api/whatever', { headers: { Cookie: `flarelo_session=${token}` } }),
      env
    );
    expect(result).toBeNull();
  });
});
