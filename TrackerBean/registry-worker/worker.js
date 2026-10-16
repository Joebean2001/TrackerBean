// TrackerBean friend registry: a tiny Cloudflare Worker that answers one question,
// "which of these Steam IDs use TrackerBean?". It stores nothing but public SteamIDs
// (no names, no playtime, no IPs), and each entry expires on its own if the app stops checking in.
//
// Routes (all POST, JSON body { ids: ["7656..."] }):
//   /register    mark these IDs as TrackerBean users (max 5 per call)
//   /unregister  remove them
//   /check       -> { have: [ids that are registered] } (max 40 per call)

const ID = /^\d{17}$/;
const TTL = 60 * 60 * 24 * 45; // seconds. The app re-announces every 12h while it runs.
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(req, env) {
    const route = new URL(req.url).pathname.replace(/\/+$/, '');
    if (req.method !== 'POST') return json({ ok: true, service: 'trackerbean-registry' });
    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
    const ids = [...new Set(Array.isArray(body && body.ids) ? body.ids : [])].filter((i) => typeof i === 'string' && ID.test(i));

    if (route === '/register') {
      await Promise.all(ids.slice(0, 5).map((id) => env.USERS.put('u:' + id, '1', { expirationTtl: TTL })));
      return json({ ok: true });
    }
    if (route === '/unregister') {
      await Promise.all(ids.slice(0, 5).map((id) => env.USERS.delete('u:' + id)));
      return json({ ok: true });
    }
    if (route === '/check') {
      const list = ids.slice(0, 40);
      const hits = await Promise.all(list.map(async (id) => ((await env.USERS.get('u:' + id)) ? id : null)));
      return json({ have: hits.filter(Boolean) });
    }
    return json({ error: 'not found' }, 404);
  },
};
