// Finds installed games: Steam libraries, Epic/GOG/Xbox/etc. folders on every drive, plus folders you add yourself.
const fs = require('fs');
const path = require('path');

// Programs that are never the game itself (matched against the file name without ".exe").
const SKIP_EXE = /^(unins\w*|uninstall\w*|setup\w*|\w*installer\w*|.*crash.*|.*redist.*|vc_?redist.*|dxsetup|dotnet.*|.*prereq.*|easyanticheat.*|eac_?launcher|battleye.*|beservice.*|.*benchmark.*|.*updater?|.*webhelper|cefprocess|7z.*|python.*|java.*|.*report.*)$/i;
// Folders that only hold engine files, redistributables, mods, etc.
const SKIP_DIRS = /^(_?commonredist|redist|directx|__installer|installer|engine|thirdparty|3rdparty|plugins|mods|logs|saved|crashreports|crashes|vcredist|dotnet|localization|docs?|node_modules|\.git)$/i;
const SKIP_FOLDERS = /^Steamworks Common Redistributables$/i;
const MAX_DEPTH = 5;      // how deep to look for the game's exe inside its folder
const MAX_DIRS = 3000;    // safety cap per game

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const uniq = (arr) => { const seen = new Set(); return arr.filter((p) => { const k = p.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); };

function driveLetters() {
  const out = [];
  for (let c = 65; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; if (exists(d)) out.push(d); }
  return out;
}

function steamCommonDirs() {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean);
  const drives = driveLetters();
  const roots = [...pf.map((p) => path.join(p, 'Steam'))];
  for (const d of drives) roots.push(d + 'Steam', d + 'Program Files (x86)\\Steam', d + 'Program Files\\Steam', d + 'SteamLibrary');
  const libs = [];
  for (const root of uniq(roots).filter(exists)) {
    libs.push(root);
    try {
      const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, '\\'));
    } catch { /* no extra libraries */ }
  }
  return uniq(libs).map((l) => path.join(l, 'steamapps', 'common')).filter(exists);
}

const OTHER_NAMES = [
  'Games', 'Epic Games', 'GOG Games', 'GOG Galaxy\\Games', 'XboxGames', 'Riot Games', 'EA Games', 'Origin Games',
  'Program Files\\Epic Games', 'Program Files (x86)\\Epic Games', 'Program Files\\EA Games', 'Program Files\\Riot Games',
  'Program Files (x86)\\GOG Galaxy\\Games', 'Program Files (x86)\\Origin Games',
  'Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games', 'Program Files\\Ubisoft\\Ubisoft Game Launcher\\games',
];
function otherRoots() {
  const out = [];
  for (const d of driveLetters()) for (const n of OTHER_NAMES) out.push(d + n);
  return uniq(out).filter(exists);
}

// Steam writes appmanifest_<id>.acf next to the "common" folder: real name and app id.
function steamManifests(commonDir) {
  const map = {};
  const apps = path.dirname(commonDir);
  let files = [];
  try { files = fs.readdirSync(apps).filter((f) => /^appmanifest_\d+\.acf$/i.test(f)); } catch { return map; }
  for (const f of files) {
    try {
      const txt = fs.readFileSync(path.join(apps, f), 'utf8');
      const appid = (txt.match(/"appid"\s+"(\d+)"/) || [])[1];
      const dir = (txt.match(/"installdir"\s+"([^"]+)"/) || [])[1];
      const name = (txt.match(/"name"\s+"([^"]+)"/) || [])[1];
      if (appid && dir) map[dir.toLowerCase()] = { appid, name };
    } catch { /* skip unreadable manifest */ }
  }
  return map;
}

function findExes(start, maxDepth) {
  const out = [];
  const stack = [[start, 0]];
  let visited = 0;
  while (stack.length && visited < MAX_DIRS) {
    const [dir, depth] = stack.pop();
    visited++;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile()) {
        if (/\.exe$/i.test(e.name) && !SKIP_EXE.test(e.name.replace(/\.exe$/i, ''))) {
          try { out.push({ name: e.name, size: fs.statSync(full).size }); } catch { /* ignore */ }
        }
      } else if (e.isDirectory() && depth < maxDepth && !SKIP_DIRS.test(e.name)) {
        stack.push([full, depth + 1]);
      }
    }
  }
  return out;
}

// The biggest programs in a game's folder are the game itself.
const pickExes = (list) => [...new Set(list.sort((a, b) => b.size - a.size).slice(0, 3).map((x) => x.name))];

// Game install folder, not a "bin" folder inside it (so folder sizes are right).
function rootInstallPath(p) {
  if (!p) return '';
  const m = String(p).match(/^(.*[\\/](?:steamapps[\\/]common|Epic Games|GOG Games|GOG Galaxy[\\/]Games|XboxGames)[\\/][^\\/]+)/i);
  return m ? m[1] : String(p);
}

// Each sub-folder of `root` is treated as one game.
function scanDir(root, manifests = {}) {
  const found = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !SKIP_FOLDERS.test(d.name)); } catch { return found; }
  for (const d of dirs) {
    const folder = path.join(root, d.name);
    const exes = pickExes(findExes(folder, MAX_DEPTH));
    if (!exes.length) continue;
    const m = manifests[d.name.toLowerCase()];
    const g = { name: (m && m.name) || d.name, exes, installPath: folder };
    if (m) g.steamAppId = m.appid;
    found.push(g);
  }
  return found;
}

// One game, given its folder (used by "Add game folder").
function scanFolder(folder) {
  const root = rootInstallPath(folder);
  const exes = pickExes(findExes(root, MAX_DEPTH));
  if (!exes.length) return null;
  let m = null;
  const sm = root.match(/^(.*[\\/]steamapps)[\\/]common[\\/]([^\\/]+)/i);
  if (sm) m = steamManifests(path.join(sm[1], 'common'))[sm[2].toLowerCase()] || null;
  const g = { name: (m && m.name) || path.basename(root), exes, installPath: root };
  if (m) g.steamAppId = m.appid;
  return g;
}

// Returns { games, checked } where `checked` lists the library folders that were searched.
function scanForGames(extraFolders = []) {
  const games = [];
  const checked = [];
  for (const root of steamCommonDirs()) { checked.push(root); games.push(...scanDir(root, steamManifests(root))); }
  for (const root of otherRoots()) { checked.push(root); games.push(...scanDir(root)); }
  for (const root of extraFolders.filter(exists)) {
    checked.push(root);
    let found = scanDir(root);
    if (!found.length) { const one = scanFolder(root); if (one) found = [one]; } // the folder itself may be one game
    games.push(...found);
  }
  const seen = new Set();
  return { games: games.filter((g) => { const k = g.installPath.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }), checked };
}
// Full path of a game's exe, given its install folder (used to read the exe's own icon).
function locateExe(installPath, exeName) {
  if (!installPath || !exeName) return null;
  const want = exeName.toLowerCase();
  const stack = [[installPath, 0]];
  let visited = 0;
  while (stack.length && visited < MAX_DIRS) {
    const [dir, depth] = stack.pop();
    visited++;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase() === want) return path.join(dir, e.name);
      if (e.isDirectory() && depth < MAX_DEPTH && !SKIP_DIRS.test(e.name)) stack.push([path.join(dir, e.name), depth + 1]);
    }
  }
  return null;
}
module.exports = { steamCommonDirs, locateExe, scanForGames, scanDir, scanFolder, steamManifests, rootInstallPath };
