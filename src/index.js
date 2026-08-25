import {
  handleSignup,
  handleLogin,
  handleLogout,
  handleInvite,
  handleAcceptInvite,
  handleRequestPasswordReset,
  handleResetPassword,
} from './routes/auth.js';
import {
  handleCreateSite,
  handleListSites,
  handleGetSite,
  handleUpdateSite,
  handleDeleteSite,
} from './routes/sites.js';
import {
  handleCreateAsset,
  handleListAssetsForSite,
  handleGetAsset,
  handleUpdateAsset,
  handleDeleteAsset,
} from './routes/assets.js';
import { handleDashboard } from './routes/dashboard.js';

const routes = [
  ['POST', '/api/auth/signup', handleSignup],
  ['POST', '/api/auth/login', handleLogin],
  ['POST', '/api/auth/logout', handleLogout],
  ['POST', '/api/auth/invite', handleInvite],
  ['POST', '/api/auth/accept-invite', handleAcceptInvite],
  ['POST', '/api/auth/request-password-reset', handleRequestPasswordReset],
  ['POST', '/api/auth/reset-password', handleResetPassword],

  ['POST', '/api/sites', handleCreateSite],
  ['GET', '/api/sites', handleListSites],
  ['GET', '/api/sites/:id', handleGetSite],
  ['PATCH', '/api/sites/:id', handleUpdateSite],
  ['DELETE', '/api/sites/:id', handleDeleteSite],

  ['POST', '/api/sites/:siteId/assets', handleCreateAsset],
  ['GET', '/api/sites/:siteId/assets', handleListAssetsForSite],
  ['GET', '/api/assets/:id', handleGetAsset],
  ['PATCH', '/api/assets/:id', handleUpdateAsset],
  ['DELETE', '/api/assets/:id', handleDeleteAsset],

  ['GET', '/api/dashboard', handleDashboard],
];

// Every route pattern segment is either a literal or a `:name`
// param — no wildcards, no regex. Segment counts must match exactly,
// so `/api/sites/:id` (3 segments) and `/api/sites/:siteId/assets`
// (4 segments) never collide regardless of route order.
function matchRoute(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i];
    if (part.startsWith(':')) {
      params[part.slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (part !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' });
    }

    for (const [method, pattern, handler] of routes) {
      if (request.method !== method) continue;
      const params = matchRoute(pattern, url.pathname);
      if (params) return handler(request, env, ctx, params);
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
