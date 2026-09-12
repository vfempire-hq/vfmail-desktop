/**
 * VF Mail updates endpoint.
 *
 * Deployed on updates.vfempire.com. Serves the signed update manifest
 * that the desktop app polls. Behind the scenes it reads from R2 —
 * releases live under r2://vfmail-updates/vfmail/<version>/... and
 * we keep a symlink-y "latest" pointer at vfmail/latest.json.
 *
 * URL shape (matches tauri.conf.json endpoint template):
 *   https://updates.vfempire.com/vfmail/{target}/{arch}/{current_version}
 *
 * We ignore target/arch/current_version and always return the latest
 * manifest — Tauri does its own version comparison client-side.
 */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health' || url.pathname === '/') {
      return json({ ok: true, service: 'vfmail-updates' });
    }
    const key = 'vfmail/latest.json';
    const obj = await env.BUCKET.get(key);
    if (!obj) return new Response('manifest missing', { status: 404 });
    return new Response(obj.body, {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=300',
        'access-control-allow-origin': '*',
      },
    });
  },
};

function json(o) {
  return new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
}
