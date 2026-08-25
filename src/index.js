import {
  handleSignup,
  handleLogin,
  handleLogout,
  handleInvite,
  handleAcceptInvite,
  handleRequestPasswordReset,
  handleResetPassword,
} from './routes/auth.js';

const routes = [
  ['POST', '/api/auth/signup', handleSignup],
  ['POST', '/api/auth/login', handleLogin],
  ['POST', '/api/auth/logout', handleLogout],
  ['POST', '/api/auth/invite', handleInvite],
  ['POST', '/api/auth/accept-invite', handleAcceptInvite],
  ['POST', '/api/auth/request-password-reset', handleRequestPasswordReset],
  ['POST', '/api/auth/reset-password', handleResetPassword],
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' });
    }

    for (const [method, path, handler] of routes) {
      if (request.method === method && url.pathname === path) {
        return handler(request, env, ctx);
      }
    }

    // Everything else falls through to static assets. In production,
    // Cloudflare serves matching files from the `assets` binding
    // directly, before this Worker even runs — this fallback just
    // keeps `wrangler dev` behaving the same way locally.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
