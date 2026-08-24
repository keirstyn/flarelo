export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' });
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
