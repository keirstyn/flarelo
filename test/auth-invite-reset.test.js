import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import schemaSql from '../db/schema.sql?raw';
import { handleInvite, handleRequestPasswordReset } from '../src/routes/auth.js';

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

// A fake sendEmail — records what would have been sent instead of
// hitting Resend for real. Passed in via handleInvite/
// handleRequestPasswordReset's third-argument override, so these
// tests need no real RESEND_API_KEY and make no network calls.
function fakeSendEmail() {
  const sent = [];
  const fn = async (_env, { to, subject, body }) => {
    sent.push({ to, subject, body });
    return { id: 'fake-email-id' };
  };
  fn.sent = sent;
  return fn;
}

async function signupOwner(overrides = {}) {
  const res = await SELF.fetch('https://example.com/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      email: 'owner@acme.test',
      password: 'ownerpassword1',
      companyName: 'Acme Co',
      ...overrides,
    }),
  });
  const cookie = res.headers.get('Set-Cookie');
  const token = cookie.match(/flarelo_session=([^;]+)/)[1];
  return { res, token };
}

function extractToken(emailBody) {
  return emailBody.match(/token=([^\s]+)/)[1];
}

describe('auth: invite', () => {
  it('owner can invite a teammate, creating an invited technician and emailing a token', async () => {
    const { token } = await signupOwner();
    const sendEmailFn = fakeSendEmail();

    const res = await handleInvite(
      new Request('https://example.com/api/auth/invite', {
        method: 'POST',
        headers: { Cookie: `flarelo_session=${token}` },
        body: JSON.stringify({ email: 'tech@acme.test' }),
      }),
      env,
      { sendEmailFn }
    );

    expect(res.status).toBe(201);
    expect(sendEmailFn.sent.length).toBe(1);
    expect(sendEmailFn.sent[0].to).toBe('tech@acme.test');

    const invitedUser = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind('tech@acme.test').first();
    expect(invitedUser.status).toBe('invited');
    expect(invitedUser.role).toBe('technician');
    expect(invitedUser.password_hash).toBeNull();
  });

  it('a technician cannot invite others', async () => {
    const { token: ownerToken } = await signupOwner();
    const sendEmailFn = fakeSendEmail();
    await handleInvite(
      new Request('https://example.com/api/auth/invite', {
        method: 'POST',
        headers: { Cookie: `flarelo_session=${ownerToken}` },
        body: JSON.stringify({ email: 'tech@acme.test' }),
      }),
      env,
      { sendEmailFn }
    );

    const inviteToken = extractToken(sendEmailFn.sent[0].body);
    const acceptRes = await SELF.fetch('https://example.com/api/auth/accept-invite', {
      method: 'POST',
      body: JSON.stringify({ token: inviteToken, password: 'techpassword1' }),
    });
    const techToken = acceptRes.headers.get('Set-Cookie').match(/flarelo_session=([^;]+)/)[1];

    const res = await handleInvite(
      new Request('https://example.com/api/auth/invite', {
        method: 'POST',
        headers: { Cookie: `flarelo_session=${techToken}` },
        body: JSON.stringify({ email: 'someoneelse@acme.test' }),
      }),
      env,
      { sendEmailFn }
    );
    expect(res.status).toBe(403);
  });

  it('accepting an invite activates the user and logs them in; the token only works once', async () => {
    const { token: ownerToken } = await signupOwner();
    const sendEmailFn = fakeSendEmail();
    await handleInvite(
      new Request('https://example.com/api/auth/invite', {
        method: 'POST',
        headers: { Cookie: `flarelo_session=${ownerToken}` },
        body: JSON.stringify({ email: 'tech2@acme.test' }),
      }),
      env,
      { sendEmailFn }
    );
    const inviteToken = extractToken(sendEmailFn.sent[0].body);

    const acceptRes = await SELF.fetch('https://example.com/api/auth/accept-invite', {
      method: 'POST',
      body: JSON.stringify({ token: inviteToken, password: 'techpassword1' }),
    });
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.headers.get('Set-Cookie')).toContain('flarelo_session=');

    const activatedUser = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind('tech2@acme.test').first();
    expect(activatedUser.status).toBe('active');

    const secondAcceptRes = await SELF.fetch('https://example.com/api/auth/accept-invite', {
      method: 'POST',
      body: JSON.stringify({ token: inviteToken, password: 'differentpassword' }),
    });
    expect(secondAcceptRes.status).toBe(400);
  });
});

describe('auth: password reset', () => {
  it('requesting a reset emails a token; using it actually changes the password', async () => {
    await signupOwner();
    const sendEmailFn = fakeSendEmail();

    const reqRes = await handleRequestPasswordReset(
      new Request('https://example.com/api/auth/request-password-reset', {
        method: 'POST',
        body: JSON.stringify({ email: 'owner@acme.test' }),
      }),
      env,
      { sendEmailFn }
    );
    expect(reqRes.status).toBe(200);
    expect(sendEmailFn.sent.length).toBe(1);

    const resetToken = extractToken(sendEmailFn.sent[0].body);
    const resetRes = await SELF.fetch('https://example.com/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: resetToken, password: 'brandnewpassword1' }),
    });
    expect(resetRes.status).toBe(200);

    const oldLoginRes = await SELF.fetch('https://example.com/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@acme.test', password: 'ownerpassword1' }),
    });
    expect(oldLoginRes.status).toBe(401);

    const newLoginRes = await SELF.fetch('https://example.com/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@acme.test', password: 'brandnewpassword1' }),
    });
    expect(newLoginRes.status).toBe(200);
  });

  it('does not leak whether an email exists, and rate-limits repeated requests', async () => {
    await signupOwner();
    const sendEmailFn = fakeSendEmail();

    const knownRes = await handleRequestPasswordReset(
      new Request('https://example.com/api/auth/request-password-reset', {
        method: 'POST',
        body: JSON.stringify({ email: 'owner@acme.test' }),
      }),
      env,
      { sendEmailFn }
    );
    const unknownRes = await handleRequestPasswordReset(
      new Request('https://example.com/api/auth/request-password-reset', {
        method: 'POST',
        body: JSON.stringify({ email: 'nobody@acme.test' }),
      }),
      env,
      { sendEmailFn }
    );
    expect(knownRes.status).toBe(200);
    expect(unknownRes.status).toBe(200);
    expect(sendEmailFn.sent.length).toBe(1); // only the known email actually got one

    const secondKnownRes = await handleRequestPasswordReset(
      new Request('https://example.com/api/auth/request-password-reset', {
        method: 'POST',
        body: JSON.stringify({ email: 'owner@acme.test' }),
      }),
      env,
      { sendEmailFn }
    );
    expect(secondKnownRes.status).toBe(200);
    expect(sendEmailFn.sent.length).toBe(1); // still just one — rate-limited
  });

  it('a reset token can only be used once', async () => {
    await signupOwner();
    const sendEmailFn = fakeSendEmail();
    await handleRequestPasswordReset(
      new Request('https://example.com/api/auth/request-password-reset', {
        method: 'POST',
        body: JSON.stringify({ email: 'owner@acme.test' }),
      }),
      env,
      { sendEmailFn }
    );
    const resetToken = extractToken(sendEmailFn.sent[0].body);

    const firstUse = await SELF.fetch('https://example.com/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: resetToken, password: 'brandnewpassword1' }),
    });
    expect(firstUse.status).toBe(200);

    const secondUse = await SELF.fetch('https://example.com/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: resetToken, password: 'anotherpassword2' }),
    });
    expect(secondUse.status).toBe(400);
  });
});
