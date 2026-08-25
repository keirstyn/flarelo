// Bare-minimum transactional email via Resend's REST API — just enough
// to fire the invite and password-reset emails Phase 2 needs. Phase 6
// expands this into the full client-facing PDF email, with SPF/DKIM
// verification added at that point.
//
// Unlike Phase 6's client-facing email (best-effort, log-and-continue),
// these two auth emails are NOT best-effort: if either fails to send,
// the caller should surface a real error, since a user with no way to
// receive their invite/reset link is a broken flow, not a shrug.
export async function sendEmail(env, { to, subject, body }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // onboarding@resend.dev is Resend's built-in sandbox sender —
      // works with zero setup but only delivers to the Resend
      // account's own verified address. Replace with a real,
      // domain-verified From address (and check SPF/DKIM, per Phase 6)
      // before real users rely on this.
      from: env.EMAIL_FROM || 'Flarelo <onboarding@resend.dev>',
      to: [to],
      subject,
      text: body,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend API error (${response.status}): ${errorText}`);
  }

  return response.json();
}
