// Steam profile + friends. Runs in the main process, so the Steam Web API key never reaches the window.
//
// How it works (no server needed):
//  - You paste a profile link to link one or more accounts.
//  - Friends are Steam profiles too. Add them by link / ID, or import your Steam friends list.
//  - Playtime comes from Steam's Web API, so a friend's hours only show if their Steam
//    "Game details" privacy is set to Public.
const { net, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pool } = require('./util');

const API = 'https://api.steampowered.com';
const TTL = 10 * 60 * 1000;             // how long a lookup is reused before asking Steam again
const MAX_FRIENDS = 200;
const ID = /^\d{17}$/;
const IMG_OK = /^https:\/\/[a-z0-9.-]*steamstatic\.com\//i;

// "Friend also has TrackerBean": a tiny free lookup service (see registry-worker/).
// Leave this empty to switch the feature off. After you deploy the worker, paste its URL here,
// e.g. 'https://trackerbean-registry.yourname.workers.dev'
const REGISTRY_URL = 'https://trackerbean-registry.distant-corncob74.workers.dev';
const REG_ANNOUNCE_EVERY = 12 * 60 * 60 * 1000;
const REG_CHECK_EVERY = 30 * 60 * 1000;

const defaults = () => ({ name: '', accounts: [], friends: [], cache: {}, main: '', share: true, combine: false });
const mainOf = (p) => ((p.accounts || []).some((a) => a.steamId === p.main) ? p.main : ((p.accounts || [])[0] || {}).steamId || '');

// What the window is allowed to see: no API key, no cache.
function publicProfile(store, safeStorage) {
  const p = store.data.profile || defaults();
  return { name: p.name || '', accounts: p.accounts || [], friends: p.friends || [], hasKey: !!(p.keyEnc || p.keyPlain), main: mainOf(p), share: p.share !== false, combine: !!p.combine, registry: !!REGISTRY_URL };
}

// Steam remembers every account that has signed in on this PC (config/loginusers.vdf).
// This only reads names and IDs, never passwords.
function steamDirs() {
  return new Promise((resolve) => {
    const fallback = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
    if (process.platform !== 'win32') return resolve(fallback);
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true }, (err, out) => {
      const m = !err && String(out).match(/SteamPath\s+REG_SZ\s+(.+)/i);
      resolve(m ? [path.normalize(m[1].trim()), ...fallback] : fallback);
    });
  });
}
async function localAccounts() {
  for (const dir of await steamDirs()) {
    try {
      const text = fs.readFileSync(path.join(dir, 'config', 'loginusers.vdf'), 'utf8');
      const out = [];
      for (const m of text.matchAll(/"(\d{17})"\s*\{([^}]*)\}/g)) {
        const f = {};
        for (const kv of m[2].matchAll(/"([^"]+)"\s+"([^"]*)"/g)) f[kv[1].toLowerCase()] = kv[2];
        out.push({ steamId: m[1], name: (f.personaname || f.accountname || m[1]).slice(0, 40), account: (f.accountname || '').slice(0, 40), recent: f.mostrecent === '1', last: Number(f.timestamp) || 0 });
      }
      if (out.length) return out.sort((a, b) => b.last - a.last);
    } catch { /* try the next folder */ }
  }
  return [];
}

function register({ ipcMain, store, safeStorage, BrowserWindow, getWin, pushChange }) {
  const P = () => {
    const d = store.data;
    d.profile = { ...defaults(), ...(d.profile || {}) };
    return d.profile;
  };

  const getKey = () => {
    const p = P();
    try { if (p.keyEnc) return safeStorage.decryptString(Buffer.from(p.keyEnc, 'base64')); } catch { return ''; }
    return p.keyPlain || '';
  };

  async function steam(pathAndQuery) {
    let res;
    try { res = await net.fetch(API + pathAndQuery, { headers: { 'User-Agent': 'TrackerBean' } }); }
    catch { throw new Error("Couldn't reach Steam. Check your internet connection."); }
    if (res.status === 401) throw new Error('private');
    if (res.status === 403) throw new Error('Steam rejected your API key. Check it and try again.');
    if (res.status === 429) throw new Error('Steam says too many requests. Wait a minute and refresh.');
    if (!res.ok) throw new Error(`Steam returned an error (${res.status}).`);
    return res.json();
  }

  // Link, ID, or custom name -> 17-digit SteamID64
  async function resolve(input) {
    const s = String(input || '').trim();
    if (!s) throw new Error('Paste a Steam profile link or ID first.');
    if (ID.test(s)) return s;
    let m = s.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
    if (m) return m[1];
    m = s.match(/steamcommunity\.com\/id\/([^/?#\s]+)/i) || s.match(/^([A-Za-z0-9_-]{2,32})$/);
    if (!m) throw new Error("That doesn't look like a Steam profile link or ID.");
    const key = getKey();
    if (!key) throw new Error('To add someone by their custom name, save your Steam API key first (or paste the long 17-digit ID).');
    const r = await steam(`/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(key)}&vanityurl=${encodeURIComponent(m[1])}`);
    if (r.response && r.response.success === 1 && ID.test(r.response.steamid)) return r.response.steamid;
    throw new Error("Steam couldn't find that profile.");
  }

  // Look up a batch of people and refresh the cache.
  async function lookup(ids, force) {
    const p = P(), key = getKey(), now = Date.now();
    const own = new Set(p.accounts.map((a) => a.steamId));
    const need = ids.filter((id) => force || !p.cache[id] || now - p.cache[id].at > TTL || (own.has(id) && !p.cache[id].playtimes && !p.cache[id].private));
    if (!need.length) return null;
    if (!key) return 'Add your Steam API key in Profile to load playtime.';
    let err = null;
    try {
      for (let i = 0; i < need.length; i += 100) {
        const chunk = need.slice(i, i + 100);
        const r = await steam(`/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${chunk.join(',')}`);
        const byId = new Map(((r.response && r.response.players) || []).map((x) => [x.steamid, x]));
        for (const id of chunk) {
          const x = byId.get(id), old = p.cache[id] || {};
          p.cache[id] = {
            ...old, steamId: id, at: now, missing: !x,
            name: x ? String(x.personaname || id).slice(0, 40) : (old.name || id),
            avatar: x && IMG_OK.test(x.avatarfull || '') ? x.avatarfull : (old.avatar || ''),
            url: x && /^https:\/\/steamcommunity\.com\//.test(x.profileurl || '') ? x.profileurl : `https://steamcommunity.com/profiles/${id}`,
            status: x ? Number(x.personastate) || 0 : 0,
            playing: x && x.gameextrainfo ? String(x.gameextrainfo).slice(0, 60) : '',
            visible: x ? x.communityvisibilitystate === 3 : false,
          };
        }
      }
      await pool(need, 4, async (id) => {
        const c = p.cache[id];
        if (c.missing || !c.visible) { Object.assign(c, { private: true, total: 0, twoWeeks: 0, count: 0, top: [] }); return; }
        try {
          const r = await steam(`/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${id}&include_appinfo=1&include_played_free_games=1&format=json`);
          const games = (r.response && r.response.games) || [];
          if (!games.length && !(r.response && r.response.game_count)) { Object.assign(c, { private: true, total: 0, twoWeeks: 0, count: 0, top: [] }); return; }
          c.private = false;
          c.count = games.length;
          c.total = games.reduce((t, g) => t + (g.playtime_forever || 0), 0);
          c.twoWeeks = games.reduce((t, g) => t + (g.playtime_2weeks || 0), 0);
          const slim = (g) => ({ appid: g.appid, name: String(g.name || g.appid).slice(0, 80), mins: g.playtime_forever || 0, mins2w: g.playtime_2weeks || 0 });
          const top = [...games].sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0)).slice(0, 12).map(slim);
          const seen = new Set(top.map((g) => g.appid));
          for (const g of [...games].filter((g) => g.playtime_2weeks).sort((a, b) => b.playtime_2weeks - a.playtime_2weeks).slice(0, 5)) if (!seen.has(g.appid)) top.push(slim(g));
          c.top = top;
          if (own.has(id)) { // every game's hours, for your own accounts only (used once per game to import your Steam hours)
            c.playtimes = {}; c.names = {};
            for (const g of games) { c.playtimes[g.appid] = g.playtime_forever || 0; if (g.name) c.names[String(g.name).toLowerCase()] = g.appid; }
          }
        } catch (e) {
          if (e.message === 'private') Object.assign(c, { private: true, total: 0, twoWeeks: 0, count: 0, top: [] });
          else { err = err || e.message; } // keep whatever we had cached
        }
      });
    } catch (e) { err = e.message; }
    store.save();
    return err;
  }

  // ---- Full game libraries, fetched on demand (never saved: friends' libraries would bloat the data file) ----
  const ownedCache = new Map(); // steamId -> { at, games:[{appid,name,mins}] }
  async function owned(id) {
    const c = ownedCache.get(id);
    if (c && Date.now() - c.at < TTL) return c.games;
    const key = getKey();
    if (!key) throw new Error('Add your Steam API key in Profile first.');
    const r = await steam(`/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${id}&include_appinfo=1&include_played_free_games=1&format=json`);
    const games = (r.response && r.response.games) || [];
    if (!games.length && !(r.response && r.response.game_count)) throw new Error('private');
    const slim = games.map((g) => ({ appid: g.appid, name: String(g.name || g.appid).slice(0, 80), mins: g.playtime_forever || 0 }));
    ownedCache.set(id, { at: Date.now(), games: slim });
    return slim;
  }
  // My library: the main account, or every linked account when "count all my accounts together" is on.
  async function myLibrary() {
    const p = P();
    const ids = p.combine ? p.accounts.map((a) => a.steamId) : [mainOf(p)].filter(Boolean);
    if (!ids.length) throw new Error('Link a Steam account first.');
    const m = new Map();
    let any = false;
    for (const id of ids) {
      try {
        for (const g of await owned(id)) { any = true; const x = m.get(g.appid); if (x) x.mins += g.mins; else m.set(g.appid, { ...g }); }
      } catch (e) { if (e.message !== 'private') throw e; }
    }
    if (!any) throw new Error('Your Steam game details are private. In Steam: Profile > Edit Profile > Privacy Settings > Game details > Public.');
    return m;
  }

  // Games you and a friend both own, most-played (combined) first.
  ipcMain.handle('social:shared', async (_e, friendId) => {
    const p = P();
    if (!p.friends.some((f) => f.steamId === friendId)) return { ok: false, error: 'That person is not in your friends list.' };
    try {
      const mine = await myLibrary();
      let theirs;
      try { theirs = await owned(friendId); }
      catch (e) { if (e.message === 'private') return { ok: false, error: "This friend's Steam game details are private, so their library can't be compared." }; throw e; }
      const list = theirs.filter((g) => mine.has(g.appid))
        .map((g) => ({ appid: g.appid, name: g.name, mine: mine.get(g.appid).mins, theirs: g.mins }))
        .sort((a, b) => (b.mine + b.theirs) - (a.mine + a.theirs));
      return { ok: true, total: list.length, mineCount: mine.size, theirCount: theirs.length, list: list.slice(0, 60) };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Games you own on Steam but have never played (0 minutes), marked with the matching tracked game if it's installed.
  ipcMain.handle('social:backlog', async (_e, force) => {
    try {
      if (force) ownedCache.clear();
      const lib = await myLibrary();
      const d = store.data;
      const list = [];
      for (const g of lib.values()) {
        if (g.mins > 0) continue;
        const inst = d.games.find((x) => (x.steamAppId && String(x.steamAppId) === String(g.appid)) || String(x.name).toLowerCase() === g.name.toLowerCase());
        if (inst && (inst.baseMin > 0 || d.sessions.some((s) => s.gameId === inst.id))) continue; // already played (Steam can lag behind)
        list.push({ appid: g.appid, name: g.name, gameId: inst ? inst.id : null });
      }
      list.sort((a, b) => (!!b.gameId - !!a.gameId) || a.name.localeCompare(b.name));
      return { ok: true, owned: lib.size, total: list.length, list: list.slice(0, 400) };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('social:install', (_e, appid) => {
    if (!/^\d{1,10}$/.test(String(appid))) return false;
    shell.openExternal(`steam://install/${appid}`);
    return true;
  });

  // One-time import of the hours you played on Steam BEFORE TrackerBean was watching.
  // baseMin = Steam's total minus what TrackerBean already counted, so nothing is counted twice.
  // It is saved once per game; from then on only TrackerBean's own sessions are added on top.
  function syncBaselines() {
    const p = P(), d = store.data;
    const ids = p.combine ? p.accounts.map((a) => a.steamId) : [mainOf(p)];
    const caches = ids.map((id) => p.cache[id]).filter((c) => c && c.playtimes);
    if (!caches.length) return false;
    let changed = false;
    for (const g of d.games) {
      if (g.baseAt) continue;
      if (d.sessions.some((s) => s.open && s.gameId === g.id)) continue; // wait until the game is closed so Steam has the session too
      const key = String(g.name || '').toLowerCase();
      let found = false, steamMin = 0;
      for (const c of caches) {
        const appid = g.steamAppId && c.playtimes[g.steamAppId] != null ? g.steamAppId : c.names && c.names[key];
        if (appid != null && c.playtimes[appid] != null) { found = true; steamMin += c.playtimes[appid]; }
      }
      if (!found) continue;
      const trackedMin = Math.round(d.sessions.filter((s) => s.gameId === g.id && !s.open).reduce((t, s) => t + Math.max(0, (s.end || s.lastSeen) - s.start), 0) / 60000);
      g.baseMin = Math.max(0, steamMin - trackedMin);
      g.baseAt = Date.now();
      changed = true;
    }
    return changed;
  }

  // ---- "Does this friend also use TrackerBean?" ----
  const reg = { announced: '', announcedAt: 0, found: new Set(), checkedKey: '', checkedAt: 0, ok: false };
  async function regCall(route, ids) {
    const res = await net.fetch(REGISTRY_URL.replace(/\/$/, '') + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'TrackerBean' },
      body: JSON.stringify({ ids }), signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error('registry ' + res.status);
    return res.json();
  }
  async function syncRegistry(force) {
    if (!REGISTRY_URL) return;
    const p = P(), now = Date.now();
    try {
      const mine = p.accounts.map((a) => a.steamId).sort();
      const mineKey = mine.join(',');
      if (p.share !== false && mine.length && (force || mineKey !== reg.announced || now - reg.announcedAt > REG_ANNOUNCE_EVERY)) {
        for (let i = 0; i < mine.length; i += 5) await regCall('/register', mine.slice(i, i + 5));
        reg.announced = mineKey; reg.announcedAt = now;
      }
      const friends = p.friends.map((f) => f.steamId).sort();
      const fKey = friends.join(',');
      if (friends.length && (force || fKey !== reg.checkedKey || now - reg.checkedAt > REG_CHECK_EVERY)) {
        const found = new Set();
        for (let i = 0; i < friends.length; i += 40) {
          const r = await regCall('/check', friends.slice(i, i + 40));
          for (const id of (r && r.have) || []) if (ID.test(id)) found.add(id);
        }
        reg.found = found; reg.checkedKey = fKey; reg.checkedAt = now; reg.ok = true;
      }
    } catch { /* the lookup service being down must never break Friends */ }
  }
  const unregister = (ids) => { if (REGISTRY_URL && ids.length) regCall('/unregister', ids).then(() => { reg.announced = ''; }).catch(() => {}); };

  const entry = (id) => {
    const c = P().cache[id];
    return c ? { ...c, hasApp: reg.found.has(id) } : { steamId: id, name: id, avatar: '', url: `https://steamcommunity.com/profiles/${id}`, status: 0, playing: '', pending: true, top: [], total: 0, twoWeeks: 0, count: 0 };
  };

  ipcMain.handle('social:data', async (_e, force) => {
    const p = P();
    const ids = [...new Set([...p.accounts.map((a) => a.steamId), ...p.friends.map((f) => f.steamId)])];
    const [error] = await Promise.all([lookup(ids, !!force), syncRegistry(!!force)]);
    if (syncBaselines()) { store.save(); pushChange(); }
    return { accounts: p.accounts.map((a) => entry(a.steamId)), friends: p.friends.map((f) => entry(f.steamId)), error, hasKey: !!getKey(), main: mainOf(p), registry: !!REGISTRY_URL && reg.ok };
  });

  ipcMain.handle('social:set-main', (_e, id) => {
    const p = P();
    if (!p.accounts.some((a) => a.steamId === id)) return false;
    p.main = id; store.save(); pushChange();
    return true;
  });

  ipcMain.handle('social:set-opts', (_e, opts) => {
    const p = P(), o = opts || {};
    if (typeof o.combine === 'boolean') p.combine = o.combine;
    if (typeof o.share === 'boolean') {
      p.share = o.share;
      if (o.share) syncRegistry(true); else unregister(p.accounts.map((a) => a.steamId));
    }
    store.save(); pushChange();
  });

  ipcMain.handle('social:local', async () => {
    const linked = new Set(P().accounts.map((a) => a.steamId));
    return (await localAccounts()).filter((a) => !linked.has(a.steamId));
  });

  ipcMain.handle('social:set-name', (_e, name) => { P().name = String(name || '').trim().slice(0, 30); store.save(); pushChange(); });

  ipcMain.handle('social:set-key', async (_e, key) => {
    const p = P(), k = String(key || '').trim();
    if (k && !/^[A-Fa-f0-9]{32}$/.test(k)) return { ok: false, error: 'A Steam API key is 32 letters and numbers. Copy it again from the Steam page.' };
    if (k) { // check it works before saving
      try { await steam(`/ISteamUser/GetPlayerSummaries/v2/?key=${k}&steamids=76561197960435530`); }
      catch (e) { return { ok: false, error: e.message === 'private' ? 'Steam rejected that key.' : e.message }; }
    }
    delete p.keyEnc; delete p.keyPlain;
    if (k) {
      try { if (safeStorage.isEncryptionAvailable()) p.keyEnc = safeStorage.encryptString(k).toString('base64'); else p.keyPlain = k; } catch { p.keyPlain = k; }
    }
    p.cache = {};
    store.save(); pushChange();
    return { ok: true, cleared: !k };
  });

  const link = (kind, id) => {
    const p = P();
    const list = kind === 'account' ? p.accounts : p.friends;
    if (p.accounts.some((a) => a.steamId === id)) return kind === 'account' ? 'That account is already linked.' : "That's one of your own accounts.";
    if (list.some((x) => x.steamId === id)) return 'Already in your list.';
    if (kind === 'friend' && list.length >= MAX_FRIENDS) return `You can have up to ${MAX_FRIENDS} friends here.`;
    list.push({ steamId: id, added: Date.now() });
    if (kind === 'account' && !p.main) p.main = id;
    return null;
  };

  ipcMain.handle('social:add', async (_e, kind, input) => {
    if (kind !== 'account' && kind !== 'friend') return { ok: false, error: 'Bad request.' };
    try {
      const id = await resolve(input);
      const bad = link(kind, id);
      if (bad) return { ok: false, error: bad };
      // a friend who was also in the friends list becomes an account: drop the friend entry
      if (kind === 'account') P().friends = P().friends.filter((f) => f.steamId !== id);
      store.save(); pushChange();
      return { ok: true, steamId: id };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('social:remove', (_e, kind, id) => {
    const p = P();
    if (kind === 'account') { p.accounts = p.accounts.filter((a) => a.steamId !== id); p.main = mainOf(p); unregister([id]); }
    else if (kind === 'friend') p.friends = p.friends.filter((f) => f.steamId !== id);
    store.save(); pushChange();
  });

  ipcMain.handle('social:import-friends', async () => {
    const p = P(), key = getKey();
    if (!p.accounts.length) return { ok: false, error: 'Link a Steam account first.' };
    if (!key) return { ok: false, error: 'Save your Steam API key first.' };
    let added = 0, privateCount = 0;
    for (const a of p.accounts) {
      try {
        const r = await steam(`/ISteamUser/GetFriendList/v1/?key=${encodeURIComponent(key)}&steamid=${a.steamId}&relationship=friend`);
        for (const f of (r.friendslist && r.friendslist.friends) || []) {
          if (p.friends.length >= MAX_FRIENDS) break;
          if (ID.test(f.steamid) && !link('friend', f.steamid)) added++;
        }
      } catch (e) {
        if (e.message === 'private') privateCount++;
        else return { ok: false, error: e.message };
      }
    }
    store.save(); pushChange();
    if (!added && privateCount === p.accounts.length) return { ok: false, error: 'Your Steam friends list is private. In Steam: Profile > Edit Profile > Privacy Settings > Friends List > Public (you can switch it back after).' };
    return { ok: true, added, privateCount };
  });

  // Used by Uninstall: take your accounts off the "friend also has TrackerBean" lookup right away (best effort).
  return {
    leaveRegistry: async () => {
      if (!REGISTRY_URL) return;
      const ids = P().accounts.map((a) => a.steamId);
      for (let i = 0; i < ids.length; i += 5) { try { await regCall('/unregister', ids.slice(i, i + 5)); } catch { /* offline: entries expire on their own */ } }
    },
  };
}

module.exports = { register, publicProfile, defaults };
