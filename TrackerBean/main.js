const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, protocol, net, shell, Notification, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const Store = require('./src/store');
const { Tracker } = require('./src/tracker');
const { scanForGames, scanFolder, rootInstallPath, locateExe, steamCommonDirs } = require('./src/scanner');
const cs2lib = require('./src/cs2');
const covers = require('./src/covers');
const { folderSize, driveInfo } = require('./src/sizes');
const { pool } = require('./src/util');
const quest = require('./src/quest');
const montage = require('./src/montage');
const tiktok = require('./src/tiktok');
const vision = require('./src/vision');
const os = require('os');
const { createUpdater } = require('./src/updater');
const social = require('./src/social');
let autoUpdaterLib = null;
try { autoUpdaterLib = require('electron-updater').autoUpdater; } catch { autoUpdaterLib = null; }

// FFmpeg ships inside the app (ffmpeg-static). In the installed app it sits next to app.asar.
let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  if (!ffmpegPath || !require('fs').existsSync(ffmpegPath)) ffmpegPath = null;
} catch { ffmpegPath = null; }

// cover://steam-123 serves cached cover art, media://<file> serves journal screenshots.
const PRIV = { standard: true, secure: true, supportFetchAPI: true };
protocol.registerSchemesAsPrivileged([{ scheme: 'cover', privileges: PRIV }, { scheme: 'media', privileges: PRIV }]);

if (!app.requestSingleInstanceLock()) app.quit();

// ---- Pop-up blocker ----
// Nothing inside TrackerBean (the app window) may open extra windows on its own,
// and the app window can never be navigated away to a website. With the blocker switched off in Settings,
// links still open in your normal browser instead of a new in-app window.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    const blocked = !store || store.data.settings.popupBlock !== false;
    if (!blocked && /^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

let win, tray, store, tracker, coverDir, journalDir, thumbDir, clipMetaFile;
let clipMeta = {};
let cs2 = null, cs2CfgDir = null, updater = null;
const scanMap = new Map();   // clip id -> { path, mtime, size } from the last scan
let musicPath = null, montageJob = null, lastOutput = null;
let quitting = false;
let sizing = false;
const startHidden = process.argv.includes('--hidden');
const seenOpen = new Set();

const BINGO_POOL = [
  'Beat a boss first try', 'Finish a game in under 5 hours', 'Play a game you know nothing about', 'Play 3 hours in one session',
  'Play something from your backlog', 'Try a new genre', 'Unlock an achievement', 'Play with a friend', 'Replay an old favourite',
  'Play before noon', 'Play past midnight', 'Beat a game you have been avoiding', 'Play a game under 2 hours long',
  'Win without dying', 'Explore without a guide', 'Find a hidden secret', 'Try a harder difficulty',
  'Play a different game every day for a week', 'Take a screenshot you love', 'Write a journal entry', 'Play something relaxing',
  'Play a game you got on sale', 'Finish a side quest', 'Play 5 days in a row', 'Play a co-op game',
  'Try a friend\'s recommendation', 'Beat your personal best', 'Play a game with a weird mechanic', 'Collect something rare',
  'Stop playing on a high note',
];

function showNotification(title, body) {
  try { if (Notification.isSupported()) new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.png') }).show(); } catch { /* ignore */ }
}
// "Quiet while gaming": hold pop-ups while a game is running and show them once it closes.
// (Where-you-left-off reminders are the point of launching a game, so they are never held.)
const heldNotes = [];
const gameRunning = () => !!(store && store.data.sessions.some((s) => s.open));
function notify(title, body, always) {
  if (!always && store && store.data.settings.quietWhileGaming && gameRunning()) {
    if (heldNotes.length < 20) heldNotes.push([title, body]);
    return;
  }
  showNotification(title, body);
}
function flushHeldNotes() {
  if (gameRunning() || !heldNotes.length) return;
  const list = heldNotes.splice(0);
  if (list.length === 1) return showNotification(list[0][0], list[0][1]);
  showNotification(`${list.length} notifications while you played`, list.map((n) => n[0]).join(' · ').slice(0, 200));
}
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m}m`);

function pushChange() {
  if (win && !win.isDestroyed()) win.webContents.send('state:changed');
}

function runQuestCheck() {
  const ev = quest.check(store.data);
  if (!ev) return;
  store.save();
  const goal = fmtMin(store.data.quest.goalMin);
  if (ev.type === 'unlocked') notify(`Unlocked: ${ev.game.name}`, `You finished ${ev.completedGame ? ev.completedGame.name : 'a game'}. Play ${goal} of ${ev.game.name} to unlock the next one.`);
  else if (ev.type === 'pending') notify('Challenge goal reached!', 'Open TrackerBean to choose your next unlock.');
  else notify('Challenge complete!', 'You worked through every game in your chain.');
  pushChange();
}

// When a game starts, remind you where you left off.
function notifyResume() {
  for (const s of store.data.sessions) {
    if (!s.open || seenOpen.has(s.id)) continue;
    seenOpen.add(s.id);
    const note = store.data.journal.filter((j) => j.left && j.gameId === s.gameId).sort((a, b) => b.createdAt - a.createdAt)[0];
    const game = store.data.games.find((g) => g.id === s.gameId);
    if (note && game && note.text) notify(`Where you left off in ${game.name}`, note.text.slice(0, 200), true);
  }
}

function onTrackerChange() { pushChange(); runQuestCheck(); notifyResume(); flushHeldNotes(); }

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 740, minWidth: 980, minHeight: 640,
    show: !startHidden, backgroundColor: '#0B0B0D', autoHideMenuBar: true, title: 'TrackerBean',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault(); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!quitting && store.data.settings.closeToTray) { e.preventDefault(); win.hide(); }
  });
}

function showWindow() { if (win) { win.show(); win.focus(); } }

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('TrackerBean is tracking your games');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open TrackerBean', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => (win.isVisible() ? win.hide() : showWindow()));
}

const COVER_KEY = /^(steam-\d+|icon-[a-f0-9-]+|custom-[a-f0-9-]+)$/;
function coverFile(key) {
  if (!COVER_KEY.test(String(key))) return null;
  for (const ext of ['jpg', 'png', 'webp', 'gif']) {
    const f = path.join(coverDir, `${key}.${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
function removeCoverFile(key) {
  if (!/^(icon|custom)-/.test(String(key || ''))) return; // never delete shared Steam art
  const f = coverFile(key);
  if (f) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
}

// Last-resort cover: the icon from the game's own .exe (Windows).
async function makeIcon(game, key) {
  for (const exe of game.exes) {
    try {
      const file = locateExe(game.installPath, exe);
      if (!file) continue;
      const img = await app.getFileIcon(file, { size: 'large' });
      if (img.isEmpty()) continue;
      fs.mkdirSync(coverDir, { recursive: true });
      fs.writeFileSync(path.join(coverDir, key + '.png'), img.toPNG());
      return key;
    } catch { /* try the next exe */ }
  }
  return null;
}

// Cover order: Steam art (exact, then fuzzy name match) -> the exe's icon -> coloured initials.
async function ensureCover(game) {
  if (game.coverCustom) return;
  const r = await covers.resolve(coverDir, game);
  if (!store.data.games.includes(game)) return;
  if (r) {
    if (game.coverKey && game.coverKey.startsWith('icon-')) removeCoverFile(game.coverKey);
    game.steamAppId = r.steamAppId; game.coverKey = r.key;
  } else {
    game.coverTriedAt = Date.now();
    if (!game.coverKey || !coverFile(game.coverKey)) {
      const key = await makeIcon(game, `icon-${game.id}`);
      if (key) game.coverKey = key;
    }
  }
  store.save(); pushChange();
}

async function refreshSizes() {
  if (sizing) return;
  sizing = true; pushChange();
  try {
    await pool([...store.data.games], 2, async (g) => {
      if (!g.installPath || !fs.existsSync(g.installPath)) { g.sizeBytes = null; g.sizeMissing = true; }
      else { g.sizeBytes = await folderSize(g.installPath); g.sizeMissing = false; }
      g.sizeAt = Date.now();
      store.save(); pushChange();
    });
  } finally { sizing = false; pushChange(); }
}

function periodBounds(p) {
  let s = new Date(); s.setHours(0, 0, 0, 0);
  let e = null;
  if (p === 'week') { s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); e = new Date(s); e.setDate(e.getDate() + 7); }
  else if (p === 'month') { s.setDate(1); e = new Date(s); e.setMonth(e.getMonth() + 1); }
  else if (p === 'year') { s.setMonth(0, 1); e = new Date(s); e.setFullYear(e.getFullYear() + 1); }
  else { s = new Date(); }
  return { start: s.getTime(), end: e ? e.getTime() : null };
}

function newBingo() {
  const pick = [...BINGO_POOL].sort(() => Math.random() - 0.5).slice(0, 16);
  return { squares: pick.map((text) => ({ text, done: false })), createdAt: Date.now() };
}

const IMG_NAME = /^[a-f0-9-]+\.(png|jpg|webp|gif)$/;

app.on('second-instance', showWindow);

app.whenReady().then(() => {
  // This app used to be called GameHub. On first launch under the new name, copy the old data over (the old folder is left untouched as a backup).
  try {
    const NEW = app.getPath('userData'), OLD = path.join(app.getPath('appData'), 'gamehub');
    if (!fs.existsSync(path.join(NEW, 'trackerbean.json')) && fs.existsSync(path.join(OLD, 'gamehub.json'))) {
      fs.mkdirSync(NEW, { recursive: true });
      const junk = /^(Cache|Code Cache|GPUCache|DawnCache|Local Storage|Session Storage|Network|blob_storage|Crashpad|Partitions|Shared Dictionary|SharedStorage|WebStorage)$/i;
      fs.cpSync(OLD, NEW, { recursive: true, filter: (src) => src === OLD || !junk.test(path.basename(src)) });
      fs.renameSync(path.join(NEW, 'gamehub.json'), path.join(NEW, 'trackerbean.json'));
    }
  } catch { /* fresh start is fine */ }
  store = new Store(path.join(app.getPath('userData'), 'trackerbean.json'));
  // Web pages can't ask for notifications, location, camera etc. (TrackerBean's own notifications are separate).
  try {
    const DENY = new Set(['notifications', 'geolocation', 'media', 'midi', 'midiSysex', 'openExternal', 'pointerLock', 'idle-detection', 'hid', 'serial', 'usb', 'bluetooth']);
    require('electron').session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(!DENY.has(permission)));
  } catch { /* older Electron: skip */ }
  try { if (store.data.settings.startWithWindows) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] }); } catch { /* not allowed here */ }
  coverDir = path.join(app.getPath('userData'), 'covers');
  journalDir = path.join(app.getPath('userData'), 'journal');
  thumbDir = path.join(app.getPath('userData'), 'clipthumbs');
  clipMetaFile = path.join(app.getPath('userData'), 'clipmeta.json');
  try { clipMeta = JSON.parse(fs.readFileSync(clipMetaFile, 'utf8')); } catch { clipMeta = {}; }

  protocol.handle('cover', (req) => {
    const file = coverFile(new URL(req.url).hostname);
    return file ? net.fetch(pathToFileURL(file).toString()) : new Response('', { status: 404 });
  });
  protocol.handle('media', (req) => {
    const name = new URL(req.url).hostname;
    let file = null;
    if (IMG_NAME.test(name)) file = path.join(journalDir, name);
    else if (/^t-[a-f0-9]{16}\.jpg$/.test(name)) file = path.join(thumbDir, name);
    if (!file || !fs.existsSync(file)) return new Response('', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // Tidy games added by an earlier version (install path inside a bin folder).
  for (const g of store.data.games) g.installPath = rootInstallPath(g.installPath);
  store.save();

  for (const s of store.data.sessions) if (s.open) seenOpen.add(s.id); // don't "resume" sessions already running at startup
  tracker = new Tracker(store, onTrackerChange);
  createWindow();
  createTray();
  tracker.start();
  setInterval(runQuestCheck, 15000);

  const WEEK = 7 * 864e5;
  const missing = store.data.games.filter((g) => !g.coverCustom && (!g.coverKey || !coverFile(g.coverKey) || (g.coverKey.startsWith('icon-') && Date.now() - (g.coverTriedAt || 0) > WEEK)));
  pool(missing, 3, ensureCover);

  // ---- CS2 match data ----
  const findCs2CfgDir = () => {
    for (const dir of steamCommonDirs()) {
      const cfg = path.join(dir, 'Counter-Strike Global Offensive', 'game', 'csgo', 'cfg');
      if (fs.existsSync(cfg)) return cfg;
    }
    return null;
  };
  if (!store.data.cs2.token) { store.data.cs2.token = crypto.randomBytes(16).toString('hex'); store.save(); }
  cs2CfgDir = findCs2CfgDir();
  cs2 = new cs2lib.Cs2({
    file: path.join(app.getPath('userData'), 'cs2matches.json'), token: store.data.cs2.token, onChange: pushChange,
    onMatch: (m) => notify(`CS2 match saved: ${m.result === 'win' ? 'Win' : m.result === 'loss' ? 'Loss' : 'Played'} ${m.score.you}-${m.score.enemy}`, `${m.map} · ${m.summary.kills}/${m.summary.deaths} · ${m.summary.adr} ADR`),
  });
  cs2.listen().then(() => pushChange());

  const cs2Status = () => ({
    port: cs2.port, listening: !!cs2.port, lastDataAt: cs2.lastDataAt, matchCount: cs2.matches.length, live: cs2.rec.live,
    configured: !!(cs2CfgDir && fs.existsSync(path.join(cs2CfgDir, cs2lib.CFG_NAME))), cfgPort: store.data.cs2.cfgPort, cfgDir: cs2CfgDir,
  });
  // ---- automatic updates (only in the installed app, and only if it was built with update info) ----
  const canUpdate = !!autoUpdaterLib && app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  updater = createUpdater({ autoUpdater: autoUpdaterLib, onChange: pushChange, enabled: canUpdate });
  if (canUpdate) { setTimeout(() => updater.check(), 15000); setInterval(() => updater.check(), 6 * 3600 * 1000); }
  ipcMain.handle('update:check', () => { updater.check(); });
  ipcMain.handle('update:install', () => { quitting = true; updater.install(); });

  ipcMain.handle('state:get', () => ({ ...store.data, profile: social.publicProfile(store), settings: { ...store.data.settings, anthropicKeyEnc: undefined, anthropicKeyPlain: undefined }, sizing, update: { ...updater.state, current: app.getVersion() }, cs2: { ...store.data.cs2, token: undefined, ...cs2Status() } }));

  ipcMain.handle('cs2:setup', () => {
    if (!cs2.port) return { ok: false, error: "TrackerBean couldn't open its listening port. Close other programs using ports 3737-3746 and restart TrackerBean." };
    const text = cs2lib.buildGsiConfig({ port: cs2.port, token: store.data.cs2.token });
    cs2CfgDir = findCs2CfgDir();
    if (!cs2CfgDir) return { ok: false, manual: true, fileName: cs2lib.CFG_NAME, text, error: "I couldn't find your CS2 folder. Create a file with this name and text in CS2's game\\csgo\\cfg folder." };
    try {
      try { fs.unlinkSync(path.join(cs2CfgDir, 'gamestate_integration_gamehub.cfg')); } catch { /* no old config */ }
      fs.writeFileSync(path.join(cs2CfgDir, cs2lib.CFG_NAME), text);
      store.data.cs2.cfgPort = cs2.port; store.save(); pushChange();
      return { ok: true, dir: cs2CfgDir };
    } catch (e) { return { ok: false, manual: true, fileName: cs2lib.CFG_NAME, text, error: `Couldn't write to ${cs2CfgDir}.` }; }
  });

  ipcMain.handle('cs2:data', () => {
    const list = cs2.matches.slice().sort((a, b) => b.startedAt - a.startedAt);
    return {
      matches: list.map((m) => ({ id: m.id, startedAt: m.startedAt, endedAt: m.endedAt, map: m.map, mode: m.mode, complete: m.complete, score: m.score, result: m.result, summary: m.summary, insights: cs2lib.insights(m.summary, { minRounds: 16, matches: 1 }), rounds: m.rounds, kills: (m.kills || []).length })),
      overview: cs2lib.overview(cs2.matches),
    };
  });
  ipcMain.handle('cs2:delete', (_e, id) => { cs2.remove(String(id)); });

  // ---- Steam profile + friends ----
  const socialApi = social.register({ ipcMain, store, safeStorage, BrowserWindow, getWin: () => win, pushChange });

  // ---- Uninstall (Settings) ----
  // Runs the installer's own uninstaller. Your data is kept unless you tick the box.
  ipcMain.handle('app:uninstall', async () => {
    if (!app.isPackaged) return { ok: false, error: 'This copy is running from its folder, not installed. To remove it, just delete the folder.' };
    const exe = path.join(path.dirname(process.execPath), 'Uninstall TrackerBean.exe');
    if (!fs.existsSync(exe)) return { ok: false, error: "Couldn't find the uninstaller. Use Windows Settings > Apps > TrackerBean > Uninstall instead." };
    const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'warning', title: 'Uninstall TrackerBean', buttons: ['Uninstall', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      message: 'Uninstall TrackerBean?',
      detail: 'TrackerBean will close and its uninstaller will open. Your games, sessions and notes are kept on this PC unless you tick the box below.',
      checkboxLabel: 'Also delete my TrackerBean data (games, sessions, notes, settings)', checkboxChecked: false,
    });
    if (r.response !== 0) return { ok: false, cancelled: true };
    try { await Promise.race([socialApi.leaveRegistry(), new Promise((res) => setTimeout(res, 5000))]); } catch { /* best effort */ }
    try { app.setLoginItemSettings({ openAtLogin: false }); } catch { /* ignore */ }
    if (r.checkboxChecked) {
      const dataDir = app.getPath('userData');
      if (/trackerbean/i.test(path.basename(dataDir))) { // safety: only ever delete TrackerBean's own folder
        try { spawn('cmd.exe', ['/c', `ping -n 8 127.0.0.1 >nul & rmdir /s /q "${dataDir}"`], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* ignore */ }
      }
    }
    try { spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); } catch { return { ok: false, error: "Couldn't start the uninstaller. Use Windows Settings > Apps > TrackerBean > Uninstall instead." }; }
    setTimeout(() => { quitting = true; app.quit(); }, 800);
    return { ok: true };
  });


  // ---- games ----
  ipcMain.handle('games:scan', async () => {
    const { games, checked } = scanForGames(store.data.settings.scanFolders || []);
    const havePaths = new Set(store.data.games.map((g) => (g.installPath || '').toLowerCase()).filter(Boolean));
    const haveExes = new Set(store.data.games.filter((g) => !g.installPath).flatMap((g) => g.exes.map((e) => e.toLowerCase())));
    const list = games.filter((g) => !havePaths.has(g.installPath.toLowerCase()) && !g.exes.every((e) => haveExes.has(e.toLowerCase())));
    await pool(list, 6, async (g) => {
      const r = await covers.resolve(coverDir, g);
      if (r) { g.steamAppId = r.steamAppId; g.coverKey = r.key; return; }
      const key = await makeIcon(g, 'icon-' + crypto.createHash('sha1').update(g.installPath).digest('hex').slice(0, 16));
      if (key) g.coverKey = key;
    });
    return { list, checked };
  });

  const addGame = (g) => {
    if (!g || typeof g.name !== 'string' || !Array.isArray(g.exes) || !g.exes.length) return null;
    const game = {
      id: crypto.randomUUID(), name: g.name.slice(0, 80),
      exes: g.exes.map((e) => String(e).slice(0, 120)),
      installPath: rootInstallPath(String(g.installPath || '')), added: Date.now(),
    };
    if (/^\d+$/.test(String(g.steamAppId || ''))) game.steamAppId = String(g.steamAppId);
    if (/^(steam-\d+|icon-[a-f0-9]{16})$/.test(String(g.coverKey || ''))) game.coverKey = g.coverKey;
    store.data.games.push(game);
    store.save(); tracker.tick(); pushChange();
    if (!game.coverKey) ensureCover(game);
    return game;
  };
  ipcMain.handle('games:add', (_e, g) => addGame(g));

  ipcMain.handle('games:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: "Pick the game's .exe", properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    return addGame({ name: path.basename(file, '.exe'), exes: [path.basename(file)], installPath: path.dirname(file) });
  });

  ipcMain.handle('games:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { title: "Pick ONE game's folder (the one that contains the game)", properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const g = scanFolder(r.filePaths[0]);
    if (!g) return { error: "No game programs were found in that folder. Try the game's main folder, or use Add .exe." };
    if (store.data.games.some((x) => (x.installPath || '').toLowerCase() === g.installPath.toLowerCase())) return { error: `${g.name} is already in your list.` };
    return { game: addGame(g) };
  });

  ipcMain.handle('folders:add', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Pick a folder that holds your games (each game in its own sub-folder)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return;
    const list = store.data.settings.scanFolders || (store.data.settings.scanFolders = []);
    if (!list.some((p) => p.toLowerCase() === r.filePaths[0].toLowerCase())) list.push(r.filePaths[0]);
    store.save(); pushChange();
  });

  ipcMain.handle('folders:remove', (_e, i) => {
    const list = store.data.settings.scanFolders || [];
    if (Number.isInteger(i) && i >= 0 && i < list.length) list.splice(i, 1);
    store.save(); pushChange();
  });

  ipcMain.handle('games:remove', (_e, id) => {
    const gone = store.data.games.find((g) => g.id === id);
    if (gone) removeCoverFile(gone.coverKey);
    store.data.games = store.data.games.filter((g) => g.id !== id);
    store.data.sessions = store.data.sessions.filter((s) => s.gameId !== id);
    const q = store.data.quest;
    q.excluded = (q.excluded || []).filter((x) => x !== id);
    if (q.current && q.current.gameId === id) quest.unlockNext(store.data); // the target game is gone: move on
    store.save(); pushChange();
  });

  // ---- change a game's image ----
  ipcMain.handle('covers:search', async (_e, term) => {
    const items = await covers.search(term);
    const ok = new Set();
    await pool(items, 4, async (it) => { if (await covers.download(coverDir, it.id)) ok.add(it.id); });
    return items.filter((it) => ok.has(it.id)).map((it) => ({ key: 'steam-' + it.id, name: it.name }));
  });

  const setCover = (g, key, custom) => {
    if (g.coverKey && g.coverKey !== key) removeCoverFile(g.coverKey);
    g.coverKey = key; g.coverCustom = custom;
    store.save(); pushChange();
  };

  ipcMain.handle('covers:set', (_e, id, key) => {
    const g = store.data.games.find((x) => x.id === id);
    if (!g || !/^steam-\d+$/.test(String(key)) || !coverFile(key)) return false;
    setCover(g, key, true);
    return true;
  });

  ipcMain.handle('covers:pick-file', async (_e, id) => {
    const g = store.data.games.find((x) => x.id === id);
    if (!g) return false;
    const r = await dialog.showOpenDialog(win, { title: `Pick an image for ${g.name}`, properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    if (r.canceled || !r.filePaths[0]) return false;
    const f = r.filePaths[0];
    const ext = path.extname(f).toLowerCase().replace('.', '').replace('jpeg', 'jpg');
    if (!['png', 'jpg', 'webp', 'gif'].includes(ext) || fs.statSync(f).size > 15 * 1024 * 1024) return false;
    const key = `custom-${crypto.randomUUID()}`;
    fs.mkdirSync(coverDir, { recursive: true });
    fs.copyFileSync(f, path.join(coverDir, `${key}.${ext}`));
    setCover(g, key, true);
    return true;
  });

  ipcMain.handle('covers:reset', (_e, id) => {
    const g = store.data.games.find((x) => x.id === id);
    if (!g) return;
    removeCoverFile(g.coverKey);
    delete g.coverKey; delete g.coverCustom; delete g.coverTriedAt;
    store.save(); pushChange();
    ensureCover(g);
  });

  ipcMain.handle('games:finish', (_e, id) => {
    const g = store.data.games.find((x) => x.id === id);
    if (g) { g.finishedAt = g.finishedAt ? null : Date.now(); store.save(); pushChange(); }
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    const s = store.data.settings;
    if (typeof patch.closeToTray === 'boolean') s.closeToTray = patch.closeToTray;
    if (typeof patch.popupBlock === 'boolean') s.popupBlock = patch.popupBlock;
    if (typeof patch.quietWhileGaming === 'boolean') { s.quietWhileGaming = patch.quietWhileGaming; if (!patch.quietWhileGaming) heldNotes.length = 0; }
    if (typeof patch.startWithWindows === 'boolean') {
      s.startWithWindows = patch.startWithWindows;
      app.setLoginItemSettings({ openAtLogin: patch.startWithWindows, args: ['--hidden'] });
    }
    store.save(); pushChange();
  });

  // ---- storage ----
  ipcMain.handle('storage:refresh', () => { refreshSizes(); });

  ipcMain.handle('storage:drives', async () => {
    const roots = new Set(store.data.games.map((g) => g.installPath).filter(Boolean).map((p) => path.parse(p).root));
    const out = [];
    for (const r of roots) { try { out.push(await driveInfo(r)); } catch { /* drive not available */ } }
    return out;
  });

  ipcMain.handle('storage:open', (_e, id) => {
    const g = store.data.games.find((x) => x.id === id);
    if (g && g.installPath) shell.openPath(g.installPath);
  });

  // Opens Steam's own uninstall prompt. Nothing is deleted without Steam asking you first.
  ipcMain.handle('storage:uninstall', (_e, id) => {
    const g = store.data.games.find((x) => x.id === id);
    if (g && /^\d+$/.test(g.steamAppId || '') && /steamapps[\\/]common/i.test(g.installPath || '')) {
      shell.openExternal(`steam://uninstall/${g.steamAppId}`);
    }
  });

  // ---- journal ----
  ipcMain.handle('journal:pick-images', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Pick screenshots', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths.slice(0, 6)) {
      try {
        if (fs.statSync(f).size > 25 * 1024 * 1024) continue;
        const ext = path.extname(f).toLowerCase().replace('.', '').replace('jpeg', 'jpg');
        if (!['png', 'jpg', 'webp', 'gif'].includes(ext)) continue;
        const name = `${crypto.randomUUID()}.${ext}`;
        fs.mkdirSync(journalDir, { recursive: true });
        fs.copyFileSync(f, path.join(journalDir, name));
        out.push(name);
      } catch { /* skip unreadable file */ }
    }
    return out;
  });

  ipcMain.handle('journal:add', (_e, j) => {
    if (!j || typeof j !== 'object') return null;
    const text = String(j.text || '').slice(0, 5000).trim();
    const images = (Array.isArray(j.images) ? j.images : []).filter((n) => IMG_NAME.test(String(n)) && fs.existsSync(path.join(journalDir, n))).slice(0, 6);
    if (!text && !images.length) return null;
    const gameId = store.data.games.some((g) => g.id === j.gameId) ? j.gameId : null;
    const entry = {
      id: crypto.randomUUID(), gameId, mood: ['great', 'good', 'meh', 'bad'].includes(j.mood) ? j.mood : 'good',
      text, images, left: !!(j.left && gameId), createdAt: Date.now(),
    };
    store.data.journal.push(entry);
    store.save(); pushChange();
    return entry;
  });

  ipcMain.handle('journal:delete', (_e, id) => {
    const e = store.data.journal.find((x) => x.id === id);
    if (!e) return;
    for (const n of e.images || []) { try { fs.unlinkSync(path.join(journalDir, n)); } catch { /* already gone */ } }
    store.data.journal = store.data.journal.filter((x) => x.id !== id);
    store.save(); pushChange();
  });

  // ---- goals ----
  ipcMain.handle('goals:add', (_e, g) => {
    if (!g || typeof g !== 'object') return null;
    const type = ['hours', 'finish', 'newgames', 'streak', 'check'].includes(g.type) ? g.type : null;
    if (!type) return null;
    const target = type === 'check' ? 1 : Math.min(10000, Math.max(1, Number(g.target) || 0));
    if (!target) return null;
    const period = type === 'streak' || type === 'check' ? 'none' : (['week', 'month', 'year', 'none'].includes(g.period) ? g.period : 'none');
    const { start, end } = periodBounds(period);
    const goal = {
      id: crypto.randomUUID(), type, target, period, start, end, created: Date.now(), doneAt: null, done: false,
      title: String(g.title || '').slice(0, 80).trim(),
      gameId: type === 'hours' && store.data.games.some((x) => x.id === g.gameId) ? g.gameId : null,
    };
    if (type === 'check' && !goal.title) return null;
    store.data.goals.push(goal);
    store.save(); pushChange();
    return goal;
  });

  ipcMain.handle('goals:delete', (_e, id) => {
    store.data.goals = store.data.goals.filter((g) => g.id !== id);
    store.save(); pushChange();
  });

  ipcMain.handle('goals:update', (_e, id, patch) => {
    const g = store.data.goals.find((x) => x.id === id);
    if (!g || !patch) return;
    if (typeof patch.done === 'boolean') g.done = patch.done;
    if (patch.doneAt === null || Number.isFinite(patch.doneAt)) g.doneAt = patch.doneAt;
    store.save(); pushChange();
  });

  ipcMain.handle('bingo:new', () => { store.data.bingo = newBingo(); store.save(); pushChange(); });
  ipcMain.handle('bingo:toggle', (_e, i) => {
    const b = store.data.bingo;
    if (b && Number.isInteger(i) && b.squares[i]) { b.squares[i].done = !b.squares[i].done; store.save(); pushChange(); }
  });


  // ---- montage ----
  const detectClipsFolder = () => {
    const vids = app.getPath('videos');
    const c = [path.join(vids, 'Medal', 'Clips'), path.join(vids, 'Medal'), path.join(vids, 'Clips')];
    for (const d of 'CDEFG') c.push(`${d}:\\Medal\\Clips`, `${d}:\\Medal`);
    return c.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || '';
  };
  const clipsFolder = () => store.data.settings.clipsFolder || detectClipsFolder();
  const outputDir = () => store.data.settings.montageDir || path.join(app.getPath('videos'), 'TrackerBean Montages');

  const getMeta = async (id) => {
    const entry = scanMap.get(id);
    if (!entry) return null;
    if (!ffmpegPath) return { duration: 0, hasAudio: false, w: 0, h: 0, thumb: false, noTools: true };
    const thumbFile = path.join(thumbDir, `t-${id}.jpg`);
    const c = clipMeta[id];
    if (c && c.mtime === entry.mtime && c.size === entry.size && (!c.thumb || fs.existsSync(thumbFile))) return c;
    const info = await montage.probe(ffmpegPath, entry.path);
    let thumb = false;
    if (info.duration > 0) { fs.mkdirSync(thumbDir, { recursive: true }); thumb = await montage.thumbnail(ffmpegPath, entry.path, thumbFile, info.duration); }
    clipMeta[id] = { ...info, thumb, mtime: entry.mtime, size: entry.size };
    return clipMeta[id];
  };

  // The Anthropic API key (for AI highlight detection) is stored encrypted when the OS allows it and never sent to the window.
  const getKey = () => {
    const st = store.data.settings;
    try { if (st.anthropicKeyEnc) return safeStorage.decryptString(Buffer.from(st.anthropicKeyEnc, 'base64')); } catch { return ''; }
    return st.anthropicKeyPlain || '';
  };
  ipcMain.handle('montage:set-key', (_e, key) => {
    const st = store.data.settings, k = String(key || '').trim();
    delete st.anthropicKeyEnc; delete st.anthropicKeyPlain;
    if (k) {
      try { if (safeStorage.isEncryptionAvailable()) st.anthropicKeyEnc = safeStorage.encryptString(k).toString('base64'); else st.anthropicKeyPlain = k; } catch { st.anthropicKeyPlain = k; }
    }
    store.save();
    return !!k;
  });
  const findFont = () => {
    const win32 = ['impact.ttf', 'arialbd.ttf', 'segoeuib.ttf', 'arial.ttf'].map((f) => path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', f));
    const other = ['/System/Library/Fonts/Supplemental/Impact.ttf', '/Library/Fonts/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'];
    return (process.platform === 'win32' ? win32 : other).find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || '';
  };

  ipcMain.handle('montage:info', () => {
    const folder = clipsFolder();
    return { folder, detected: !store.data.settings.clipsFolder && !!folder, outputDir: outputDir(), hasFfmpeg: !!ffmpegPath, music: musicPath ? path.basename(musicPath) : null, hasKey: !!getKey() };
  });

  ipcMain.handle('montage:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Pick the folder where your clips are saved', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    store.data.settings.clipsFolder = r.filePaths[0];
    store.save(); pushChange();
    return r.filePaths[0];
  });

  ipcMain.handle('montage:pick-output', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Where should finished montages be saved?', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    store.data.settings.montageDir = r.filePaths[0];
    store.save();
    return r.filePaths[0];
  });

  ipcMain.handle('montage:scan', () => {
    scanMap.clear();
    const folder = clipsFolder();
    if (!folder || !fs.existsSync(folder)) return [];
    const list = montage.scanClips(folder);
    for (const c of list) scanMap.set(c.id, c);
    return list.map(({ path: _p, ...rest }) => rest); // the renderer never needs real file paths
  });

  ipcMain.handle('montage:meta', async (_e, ids) => {
    const out = {};
    await pool((Array.isArray(ids) ? ids : []).slice(0, 40), 3, async (id) => { out[id] = await getMeta(String(id)); });
    try { fs.writeFileSync(clipMetaFile, JSON.stringify(clipMeta)); } catch { /* cache only */ }
    return out;
  });

  ipcMain.handle('montage:pick-music', async (_e, arg) => {
    if (arg === 'clear') { musicPath = null; return null; }
    const r = await dialog.showOpenDialog(win, { title: 'Pick a music file', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    musicPath = r.filePaths[0];
    return path.basename(musicPath);
  });

  // ---- making the video (shared by "pick clips myself" and the automatic editor) ----
  let montageBusy = false, montageCancelled = false;
  const emitProgress = (stage, pct) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('montage:progress', { stage, pct });
    if (stage === 'render') win.setProgressBar(pct);
  };
  const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const RES = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440] };
  const makeOpts = (p) => {
    const [width, height] = RES[String(p.res)] || RES[1080];
    return {
      transition: ['cut', 'crossfade', 'fadeblack'].includes(p.transition) ? p.transition : 'crossfade',
      width, height, fps: Number(p.fps) === 30 ? 30 : 60,
      trimLast: [10, 15, 20].includes(Number(p.trimLast)) ? Number(p.trimLast) : 0,
      clipVol: clamp(p.clipVol, 0, 100, 100), musicVol: clamp(p.musicVol, 0, 100, 60),
      music: p.music && musicPath && fs.existsSync(musicPath) ? musicPath : null,
    };
  };

  // build(output) -> { args, total, cleanup? }
  async function renderJob(build, rawName) {
    const dir = outputDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return { ok: false, error: `Couldn't create the folder ${dir}.` }; }
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
    const safe = String(rawName || 'Montage').replace(/[^\w \-.()]/g, '').trim().slice(0, 60) || 'Montage';
    const output = path.join(dir, `${safe} ${stamp}.mp4`);
    const { args, total, cleanup } = build(output);
    if (montageCancelled) { if (cleanup) cleanup(); return { ok: false, cancelled: true, error: 'Cancelled.' }; }
    montageJob = montage.run(ffmpegPath, args, total, (pct) => emitProgress('render', pct));
    const r = await montageJob.promise;
    montageJob = null;
    if (cleanup) cleanup();
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
    if (!r.ok) {
      try { fs.unlinkSync(output); } catch { /* nothing written */ }
      return { ok: false, cancelled: r.cancelled, error: r.cancelled ? 'Cancelled.' : 'Rendering failed: ' + r.tail.split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 300) };
    }
    lastOutput = output;
    notify('Montage ready', path.basename(output));
    return { ok: true, output: path.basename(output), folder: dir, total };
  }

  // Renders a styled montage in pieces of ~24 cuts (each cut is an FFmpeg input, so one run can't hold hundreds),
  // then joins the pieces and lays the song under them. Pieces are cut on exact frame/sample counts so the beat never drifts.
  async function renderChunked(plan, oo, rawName, extraCleanup) {
    const dir = outputDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return { ok: false, error: `Couldn't create the folder ${dir}.` }; }
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
    const safe = String(rawName || 'Montage').replace(/[^\w \-.()]/g, '').trim().slice(0, 60) || 'Montage';
    const output = path.join(dir, `${safe} ${stamp}.mp4`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trackerbean-pieces-'));
    const CH = 24, pieces = [];
    for (let i = 0; i < plan.segments.length; i += CH) pieces.push(plan.segments.slice(i, i + CH));
    const total = plan.segments.reduce((t, s) => t + s.dur, 0);
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ } if (extraCleanup) extraCleanup(); if (win && !win.isDestroyed()) win.setProgressBar(-1); };
    const fail = (r) => { cleanup(); try { fs.unlinkSync(output); } catch { /* nothing written */ } return { ok: false, cancelled: r.cancelled, error: r.cancelled ? 'Cancelled.' : 'Rendering failed: ' + String(r.tail || '').split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 300) }; };
    let t0 = 0, idx0 = 0;
    const files = [];
    for (let k = 0; k < pieces.length; k++) {
      if (montageCancelled) return fail({ cancelled: true });
      const seg = pieces[k], file = path.join(tmp, `p${String(k).padStart(3, '0')}.mkv`);
      const built = tiktok.buildTikTokArgs({ segments: seg }, { ...oo, music: null, synth: null, chunk: true, t0, idx0, output: file });
      const script = path.join(tmp, `f${k}.txt`);
      fs.writeFileSync(script, built.filter);
      montageJob = montage.run(ffmpegPath, [...built.args, '-filter_complex_script', script, ...built.tail], built.total, (pct) => emitProgress('render', Math.min(0.95, ((k + pct) / pieces.length) * 0.95)));
      const r = await montageJob.promise; montageJob = null;
      if (!r.ok) return fail(r);
      files.push(file); t0 += built.total; idx0 += seg.length;
    }
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    const join = tiktok.buildJoinArgs({ list, music: oo.music, synth: oo.synth, firstBeat: oo.firstBeat, musicVol: oo.musicVol, total, output });
    montageJob = montage.run(ffmpegPath, join.args, total, (pct) => emitProgress('render', 0.95 + pct * 0.05));
    const r = await montageJob.promise; montageJob = null;
    if (!r.ok) return fail(r);
    cleanup();
    lastOutput = output;
    notify('Montage ready', path.basename(output));
    return { ok: true, output: path.basename(output), folder: dir, total };
  }

  // Resolve clip ids from the last scan into { path, duration, hasAudio } (ids only: the renderer never sends file paths).
  async function loadClips(ids, max) {
    const out = [];
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, max)) {
      const entry = scanMap.get(String(id));
      const meta = entry && await getMeta(String(id));
      if (!entry || !meta || !meta.duration) return { error: "One of the selected clips couldn't be read. Rescan and try again." };
      out.push({ id: String(id), path: entry.path, mtime: entry.mtime, duration: meta.duration, hasAudio: meta.hasAudio, levels: meta.lvRate === 10 ? meta.lv : undefined, rate: 10 });
    }
    return { clips: out };
  }

  const toolCheck = () => {
    if (montageBusy) return { ok: false, error: 'A montage is already being made.' };
    if (!ffmpegPath) return { ok: false, error: 'The video tools are missing. Re-run update.bat (it needs internet to download them).' };
    return null;
  };

  // Pick the clips yourself, then it edits them together.
  ipcMain.handle('montage:make', async (_e, p) => {
    const bad = toolCheck(); if (bad) return bad;
    montageBusy = true; montageCancelled = false;
    try {
      const r = await loadClips(p.ids, 40);
      if (r.error) return { ok: false, error: r.error };
      if (!r.clips.length) return { ok: false, error: 'Pick at least one clip.' };
      const opts = makeOpts(p);
      return await renderJob((output) => montage.buildArgs(r.clips, { ...opts, output }), p.name);
    } finally { montageBusy = false; }
  });

  // Fully automatic. Listens for the big moment in every clip, then edits them together,
  // either "clean" (smooth crossfades) or "tiktok" (beat-synced cuts, slow-mo, zoom punches, flashes).
  ipcMain.handle('montage:auto', async (_e, p) => {
    const bad = toolCheck(); if (bad) return bad;
    montageBusy = true; montageCancelled = false;
    try {
      let ids = p.ids, match = null;
      if (p.matchId) { // highlights of a recorded CS2 match: clips saved during (or just after) it
        match = cs2.getMatch(String(p.matchId));
        if (!match || !(match.kills || []).length) return { ok: false, error: 'That match has no recorded kills.' };
        ids = [...scanMap.values()].filter((c) => c.mtime >= match.startedAt - 30000 && c.mtime <= match.endedAt + 180000).sort((a, b) => a.mtime - b.mtime).map((c) => c.id);
        if (!ids.length) return { ok: false, error: 'No clips were saved around the time of that match. Check the clips folder.' };
      }
      const r = await loadClips(ids, 150);
      if (r.error) return { ok: false, error: r.error };
      let items = r.clips;
      if (!items.length) return { ok: false, error: 'There are no clips to work with.' };
      let done = 0;
      emitProgress('analyze', 0);
      await pool(items, 3, async (it) => {
        if (montageCancelled) return;
        if (!it.levels) {
          it.levels = it.hasAudio ? await montage.loudness(ffmpegPath, it.path, 10) : [];
          if (clipMeta[it.id]) { clipMeta[it.id].lv = it.levels; clipMeta[it.id].lvRate = 10; }
        }
        emitProgress('analyze', ++done / items.length);
      });
      try { fs.writeFileSync(clipMetaFile, JSON.stringify(clipMeta)); } catch { /* cache only */ }
      if (montageCancelled) return { ok: false, cancelled: true, error: 'Cancelled.' };
      if (match) {
        for (const it of items) it.moments = cs2lib.momentsForClip(match.kills, it);
        items = items.filter((it) => it.moments.length);
        if (!items.length) return { ok: false, error: "Couldn't match any recorded kills to those clips." };
      }
      const fillSong = p.target === 'song';
      let target = [30, 60, 120].includes(Number(p.target)) ? Number(p.target) : 60;
      const music = !!p.music && musicPath && fs.existsSync(musicPath) ? musicPath : null;
      if (fillSong && !music) return { ok: false, error: 'Choose a song first, then TrackerBean can fill it with your clips.' };
      // game sound: 'auto' keeps the old behaviour (quiet under a song, louder with the generated beat)
      const volOf = (auto) => (p.clipVol === 'auto' || p.clipVol == null || !Number.isFinite(Number(p.clipVol)) ? auto : clamp(p.clipVol, 0, 100, auto));
      const notes0 = [];
      if (fillSong) { // how long is the song? (clean style needs it here; the styled one finds it while listening for the beat)
        const mi = await montage.probe(ffmpegPath, music);
        if (!(mi.duration > 5)) return { ok: false, error: "Couldn't read how long that song is." };
        target = Math.min(900, mi.duration);
      }

      if (['tiktok', 'phonk', 'hype', 'smooth'].includes(p.style)) {
        const style = tiktok.styleOf(p.style === 'tiktok' ? 'phonk' : p.style);
        const fx = { slow: !p.fx || p.fx.slow !== false, zoom: !p.fx || p.fx.zoom !== false, flash: !p.fx || p.fx.flash !== false, grade: !p.fx || p.fx.grade !== false, rgb: !p.fx || p.fx.rgb !== false };
        const notes = [...notes0];

        // AI vision: let Claude look at frames from the loudest clips and pick the real highlights
        const key = getKey();
        if (p.detect === 'vision' && !match) {
          if (!key) notes.push('AI highlight detection needs an Anthropic API key, so sound was used instead.');
          else {
            const ranked = [...items].sort((x, y) => montage.bestWindow(y.levels || [], y.duration, 3, 10).score - montage.bestWindow(x.levels || [], x.duration, 3, 10).score).slice(0, fillSong ? 30 : 14);
            let vdone = 0, vfail = null;
            emitProgress('analyze', 0);
            await pool(ranked, 2, async (it) => {
              if (montageCancelled || vfail) return;
              try {
                const mo = await vision.findMoments(ffmpegPath, key, it, (scanMap.get(it.id) || {}).folder);
                if (mo.length) it.moments = mo;
              } catch (e) { vfail = vfail || e; }
              emitProgress('analyze', ++vdone / ranked.length);
            });
            if (montageCancelled) return { ok: false, cancelled: true, error: 'Cancelled.' };
            if (vfail) notes.push(`AI highlight detection failed (${String(vfail.message).slice(0, 120)}), so sound was used for the rest.`);
          }
        }

        let beat = null;
        if (music) {
          const x = await tiktok.decodeMono(ffmpegPath, music, 22050);
          beat = x ? tiktok.detectBeats(x, 22050) : null;
          if (!beat || beat.confidence < 4) { notes.push("Couldn't find a clear beat in that song, so cuts follow a steady rhythm instead."); beat = x ? { bpm: style.bpm, beatLen: 60 / style.bpm, firstBeat: 0, duration: x.length / 22050 } : null; }
        }
        if (!beat) beat = { bpm: style.bpm, beatLen: 60 / style.bpm, firstBeat: 0, duration: null };
        if (fillSong && beat.duration) target = Math.max(5, beat.duration - beat.firstBeat - 0.3);
        const plan = tiktok.planTikTok(items, beat, { target, slow: fx.slow, musicDuration: music ? beat.duration : null, style, fill: fillSong });
        if (!plan.segments.length) return { ok: false, error: 'No usable moments were found in those clips.' };
        if (fillSong && plan.total < target - 4) notes.push(`There weren't enough exciting moments to fill the whole song, so the montage is ${Math.round(plan.total)}s of its ${Math.round(target)}s. Add more clips to fill it.`);

        const vertical = p.format !== 'wide';
        const has = await tiktok.listFilters(ffmpegPath);
        const caption = String(p.caption || '').trim().slice(0, 80);
        const font = caption ? findFont() : '';
        if (caption && (!font || !has.drawtext)) notes.push("The caption was skipped: no usable font or text tool was found.");
        const captionFile = caption && font && has.drawtext ? path.join(os.tmpdir(), `trackerbean-caption-${Date.now()}.txt`) : '';
        if (captionFile) fs.writeFileSync(captionFile, caption.toUpperCase());
        const oo = {
          width: vertical ? 1080 : 1920, height: vertical ? 1920 : 1080, fps: 60, music, synth: music ? null : { beatLen: beat.beatLen },
          firstBeat: beat.firstBeat, beatLen: beat.beatLen, clipVol: volOf(music ? 35 : 70), musicVol: music ? 85 : 80, fx, style, has,
          framing: vertical ? (p.framing === 'fill' ? 'fill' : 'blur') : 'fit', caption, captionFont: captionFile ? font : '', captionFile,
        };
        if (plan.segments.length > 36) { // too many cuts for one FFmpeg run: render in pieces, then join and add the song
          const res = await renderChunked(plan, oo, p.name, () => { if (captionFile) { try { fs.unlinkSync(captionFile); } catch { /* temp file */ } } });
          return res.ok ? { ...res, used: plan.segments.length, of: new Set(plan.segments.map((sg) => sg.item.id)).size, unit: 'moments', note: notes.join(' ') } : res;
        }
        const res = await renderJob((output) => {
          const built = tiktok.buildTikTokArgs(plan, { ...oo, output });
          const script = path.join(os.tmpdir(), `trackerbean-filter-${Date.now()}.txt`);
          fs.writeFileSync(script, built.filter);
          return { args: [...built.args, '-filter_complex_script', script, ...built.tail], total: built.total, cleanup: () => { for (const f of [script, captionFile]) { try { if (f) fs.unlinkSync(f); } catch { /* temp file */ } } } };
        }, p.name);
        return res.ok ? { ...res, used: plan.segments.length, of: new Set(plan.segments.map((sg) => sg.item.id)).size, unit: 'moments', note: notes.join(' ') } : res;
      }

      const plan = montage.planAuto(items, { target, winLen: target === 30 ? 8 : target >= 120 ? 12 : 10 });
      const clips = plan.map((pl) => { const it = items.find((x) => x.id === pl.id); return { path: it.path, duration: it.duration, hasAudio: it.hasAudio, ss: pl.ss, keep: pl.keep }; });
      const opts = makeOpts({ transition: 'crossfade', res: 1080, fps: 60, clipVol: volOf(music ? 35 : 100), musicVol: 60, music: !!music });
      const res = await renderJob((output) => montage.buildArgs(clips, { ...opts, output }), p.name);
      return res.ok ? { ...res, used: clips.length, of: items.length } : res;
    } finally { montageBusy = false; }
  });

  ipcMain.handle('montage:cancel', () => { montageCancelled = true; if (montageJob) montageJob.cancel(); });

  ipcMain.handle('montage:reveal', (_e, kind) => {
    if (!lastOutput || !fs.existsSync(lastOutput)) return;
    if (kind === 'open') shell.openPath(lastOutput); else shell.showItemInFolder(lastOutput);
  });

  // ---- challenge (unlock chain) ----
  ipcMain.handle('quest:start', (_e, p) => {
    const g = store.data.games.find((x) => x.id === (p && p.gameId));
    const q = store.data.quest;
    if (!g || (q.excluded || []).includes(g.id)) return;
    q.goalMin = Math.min(6000, Math.max(5, Math.round(Number(p.goalMin)) || 120));
    q.mode = p.mode === 'choose' ? 'choose' : 'random';
    q.completed = []; q.pending = false; q.finished = false; q.lastUnlock = null;
    q.current = { gameId: g.id, since: Date.now() };
    store.save(); pushChange();
  });

  ipcMain.handle('quest:choose', (_e, id) => {
    const q = store.data.quest;
    if (!q.pending || !quest.candidates(store.data).some((g) => g.id === id)) return;
    q.current = { gameId: id, since: Date.now() };
    q.lastUnlock = { gameId: id, at: Date.now() };
    q.pending = false;
    store.save(); pushChange();
  });

  ipcMain.handle('quest:reroll', () => {
    const q = store.data.quest;
    if (!q.current || q.mode !== 'random' || quest.progressMs(store.data) >= 10 * 60000) return;
    const pool2 = quest.candidates(store.data);
    if (!pool2.length) return;
    const next = pool2[Math.floor(Math.random() * pool2.length)];
    q.current = { gameId: next.id, since: Date.now() };
    q.lastUnlock = null;
    store.save(); pushChange();
  });

  // Leave a game out of (or back into) the challenge. The current target can't be left out.
  ipcMain.handle('quest:exclude', (_e, id, excluded) => {
    const q = store.data.quest;
    if (!store.data.games.some((g) => g.id === id) || (q.current && q.current.gameId === id)) return;
    q.excluded = (q.excluded || []).filter((x) => x !== id);
    if (excluded) q.excluded.push(id);
    if (q.pending && !quest.candidates(store.data).length) { q.pending = false; q.finished = true; }
    store.save(); pushChange();
  });

  // Keep only these games in the challenge (everything else is left out). The current target always stays in.
  ipcMain.handle('quest:only', (_e, ids) => {
    const q = store.data.quest, keep = new Set((Array.isArray(ids) ? ids : []).map(String));
    q.excluded = store.data.games.filter((g) => !keep.has(g.id) && !(q.current && q.current.gameId === g.id)).map((g) => g.id);
    if (q.pending && !quest.candidates(store.data).length) { q.pending = false; q.finished = true; }
    store.save(); pushChange();
  });

  ipcMain.handle('quest:reset', () => {
    const q = store.data.quest;
    store.data.quest = { ...quest.defaults(), goalMin: q.goalMin, mode: q.mode, excluded: q.excluded || [] };
    store.save(); pushChange();
  });
});

app.on('before-quit', () => { quitting = true; if (tracker) tracker.stop(); });
app.on('window-all-closed', () => { /* stay alive in the tray */ });
