// Copies all play-time data from GameHub into TrackerBean (called by migrate-gamehub-to-trackerbean.bat).
//
//  - Games that exist in both apps are matched (Steam ID, install folder, or name) and merged.
//  - Games only in GameHub are added to TrackerBean, with their cover art.
//  - Every GameHub session is added unless TrackerBean already has that time recorded,
//    so running this twice, or having both apps open at once in the past, won't double-count.
//  - TrackerBean's data file is backed up first.
//
// Usage:  node migrate-gamehub.js [gamehub-folder] [trackerbean-folder]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
const SRC = path.resolve(process.argv[2] || path.join(appData, 'gamehub'));
const DST = path.resolve(process.argv[3] || path.join(appData, 'trackerbean'));
const SRC_FILE = path.join(SRC, 'gamehub.json');
const DST_FILE = path.join(DST, 'trackerbean.json');
const MIN_SESSION_MS = 60 * 1000;

const fail = (msg) => { console.error('\n  ' + msg + '\n'); process.exit(1); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hours = (ms) => (ms / 3600000).toFixed(1) + ' h';
const normName = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normPath = (p) => String(p || '').toLowerCase().replace(/[\\/]+$/, '');

if (!fs.existsSync(SRC_FILE)) fail(`Couldn't find GameHub's data file:\n  ${SRC_FILE}\n  Open GameHub at least once, or pass its folder as the first argument.`);

let src, dst;
try { src = readJson(SRC_FILE); } catch (e) { fail("GameHub's data file couldn't be read (" + e.message + '). Nothing was changed.'); }
if (fs.existsSync(DST_FILE)) {
  try { dst = readJson(DST_FILE); } catch (e) { fail("TrackerBean's data file couldn't be read (" + e.message + '). Nothing was changed.'); }
} else dst = {};
dst.games = Array.isArray(dst.games) ? dst.games : [];
dst.sessions = Array.isArray(dst.sessions) ? dst.sessions : [];
const srcGames = Array.isArray(src.games) ? src.games : [];
const srcSessions = Array.isArray(src.sessions) ? src.sessions : [];

// ---- back up TrackerBean's file ----
fs.mkdirSync(DST, { recursive: true });
if (fs.existsSync(DST_FILE)) {
  const t = new Date(), p = (n) => String(n).padStart(2, '0');
  const stamp = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
  const backup = path.join(DST, `trackerbean.json.backup-${stamp}`);
  fs.copyFileSync(DST_FILE, backup);
  console.log('  Backup saved: ' + backup);
}

// ---- games ----
const findMatch = (g) => {
  const name = normName(g.name), pth = normPath(g.installPath);
  return dst.games.find((x) => x.id === g.id)
    || (g.steamAppId && dst.games.find((x) => x.steamAppId && String(x.steamAppId) === String(g.steamAppId)))
    || (pth && dst.games.find((x) => normPath(x.installPath) === pth))
    || (name && dst.games.find((x) => normName(x.name) === name))
    || null;
};
const idMap = new Map();   // GameHub game id -> TrackerBean game id
let gamesAdded = 0, gamesMerged = 0;
const usedIds = new Set(dst.games.map((g) => g.id));
for (const g of srcGames) {
  if (!g || !g.id || typeof g.name !== 'string') continue;
  const hit = findMatch(g);
  if (hit) {
    idMap.set(g.id, hit.id);
    hit.exes = [...new Set([...(hit.exes || []), ...(g.exes || [])])];
    for (const k of ['steamAppId', 'coverKey', 'installPath', 'coverCustom']) if (!hit[k] && g[k]) hit[k] = g[k];
    if (g.added && (!hit.added || g.added < hit.added)) hit.added = g.added;
    gamesMerged++;
  } else {
    const copy = { ...g };
    if (usedIds.has(copy.id)) copy.id = crypto.randomUUID();
    usedIds.add(copy.id);
    dst.games.push(copy);
    idMap.set(g.id, copy.id);
    gamesAdded++;
  }
}

// ---- sessions ----
const overlapMs = (aStart, aEnd, b) => Math.max(0, Math.min(aEnd, b.end) - Math.max(aStart, b.start));
const byGame = new Map();
for (const s of dst.sessions) {
  if (!s || typeof s.start !== 'number') continue;
  const end = s.open ? (s.lastSeen || Date.now()) : s.end;
  if (typeof end !== 'number') continue;
  if (!byGame.has(s.gameId)) byGame.set(s.gameId, []);
  byGame.get(s.gameId).push({ start: s.start, end, id: s.id });
}
let sAdded = 0, sDup = 0, sBad = 0, addedMs = 0;
for (const s of srcSessions) {
  const gameId = idMap.get(s && s.gameId);
  if (!gameId || typeof s.start !== 'number') { sBad++; continue; }
  const end = s.open ? s.lastSeen : s.end;       // a session still "open" in GameHub ended at its last heartbeat
  if (typeof end !== 'number' || end - s.start < MIN_SESSION_MS) { sBad++; continue; }
  const have = byGame.get(gameId) || [];
  // already recorded? same session id, or more than half of its time is already covered
  const covered = have.reduce((t, b) => t + overlapMs(s.start, end, b), 0);
  if (have.some((b) => b.id === s.id) || covered >= (end - s.start) / 2) { sDup++; continue; }
  const id = (s.id && !dst.sessions.some((x) => x.id === s.id)) ? s.id : crypto.randomUUID();
  dst.sessions.push({ id, gameId, start: s.start, end, lastSeen: end, open: false });
  have.push({ start: s.start, end, id }); byGame.set(gameId, have);
  sAdded++; addedMs += end - s.start;
}
dst.sessions.sort((a, b) => a.start - b.start);

// ---- cover art for the games that came across (never overwrites) ----
const copyDir = (from, to) => {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, f.name), b = path.join(to, f.name);
    if (f.isDirectory()) n += copyDir(a, b);
    else if (!fs.existsSync(b)) { fs.copyFileSync(a, b); n++; }
  }
  return n;
};
const covers = copyDir(path.join(SRC, 'covers'), path.join(DST, 'covers'));

// ---- save (write a temp file, then rename, so a crash can't leave half a file) ----
const tmp = DST_FILE + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(dst));
fs.renameSync(tmp, DST_FILE);

console.log('');
console.log(`  Games:     ${gamesAdded} added, ${gamesMerged} already in TrackerBean (merged)`);
console.log(`  Sessions:  ${sAdded} added (${hours(addedMs)} of play time), ${sDup} skipped as already recorded${sBad ? `, ${sBad} unusable` : ''}`);
console.log(`  Covers:    ${covers} image${covers === 1 ? '' : 's'} copied`);
console.log(`  TrackerBean now has ${dst.games.length} games and ${dst.sessions.length} sessions.`);
