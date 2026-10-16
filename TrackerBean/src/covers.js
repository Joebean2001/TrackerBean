// Cover art from Steam's public image server, cached on disk so it works offline afterwards.
const fs = require('fs');
const path = require('path');

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Different spellings of a game's name to try (folder names are often messy).
function variants(name) {
  const out = [String(name).trim()];
  let n = String(name)
    .replace(/[\(\[].*?[\)\]]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')          // EldenRing -> Elden Ring
    .replace(/[_\-.]+/g, ' ')
    .replace(/\b(win(32|64)?|x64|x86|shipping|game of the year|goty|definitive|remastered|deluxe|complete|enhanced|edition|demo|playtest|beta|launcher)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  if (n && !out.includes(n)) out.push(n);
  return out;
}

async function searchSteam(term) {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=us`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  return (await res.json()).items || [];
}

async function findAppId(name) {
  for (const term of variants(name)) {
    const n = norm(term);
    if (n.length < 3) continue;
    let items = [];
    try { items = await searchSteam(term); } catch { continue; }
    // Only accept a clear name match, so a wrong picture is never shown.
    const hit = items.find((i) => norm(i.name) === n) || (n.length >= 5 && items.find((i) => norm(i.name).startsWith(n)));
    if (hit) return String(hit.id);
  }
  return null;
}

// For the "Change image" search box: top matches for whatever you type.
async function search(term) {
  try { return (await searchSteam(String(term))).slice(0, 8).map((i) => ({ id: String(i.id), name: i.name })); } catch { return []; }
}

async function download(dir, appid) {
  const key = `steam-${appid}`;
  const file = path.join(dir, key + '.jpg');
  if (fs.existsSync(file)) return key;
  const res = await fetch(`https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) return null;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buf);
  return key;
}

// Returns { steamAppId, key } or null when no cover could be found.
async function resolve(dir, game) {
  try {
    const appid = game.steamAppId || (await findAppId(game.name));
    if (!appid) return null;
    const key = await download(dir, appid);
    return key ? { steamAppId: String(appid), key } : null;
  } catch { return null; }
}
module.exports = { resolve, findAppId, search, download, variants };
