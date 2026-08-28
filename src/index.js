import {
  handleSignup,
  handleLogin,
  handleMe,
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
import { handlePdfSmokeTest } from './routes/pdf-smoke-test.js';
import { handleSubmitInspection, handleGetInspectionPdf, handleGetChecklistForAsset } from './routes/inspections.js';
import { handleUploadPhoto, handleUploadSignature } from './routes/uploads.js';
import { handleListDeficiencies, handleUpdateDeficiency } from './routes/deficiencies.js';
import {
  handleOverdueAssets,
  handleDeficiencySummary,
  handleRecentInspections,
} from './routes/office-dashboard.js';

const routes = [
  ['POST', '/api/auth/signup', handleSignup],
  ['POST', '/api/auth/login', handleLogin],
  ['POST', '/api/auth/logout', handleLogout],
  ['GET', '/api/auth/me', handleMe],
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
  ['GET', '/api/dev/pdf-smoke-test', handlePdfSmokeTest],
  ['POST', '/api/assets/:assetId/inspections', handleSubmitInspection],
  ['GET', '/api/inspections/:id/pdf', handleGetInspectionPdf],
  ['GET', '/api/assets/:assetId/checklist', handleGetChecklistForAsset],
  ['POST', '/api/assets/:assetId/photos', handleUploadPhoto],
  ['POST', '/api/assets/:assetId/signature', handleUploadSignature],
  ['GET', '/api/deficiencies', handleListDeficiencies],
  ['PATCH', '/api/deficiencies/:id', handleUpdateDeficiency],
  ['GET', '/api/dashboard/overdue', handleOverdueAssets],
  ['GET', '/api/dashboard/deficiency-summary', handleDeficiencySummary],
  ['GET', '/api/dashboard/recent-inspections', handleRecentInspections],
];

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
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
};
