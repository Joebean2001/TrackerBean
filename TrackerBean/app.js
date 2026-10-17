const $ = (s) => document.querySelector(s);
let state = { update: {}, games: [], sessions: [], settings: {}, journal: [], goals: [], bingo: null, quest: {}, profile: { name: '', accounts: [], friends: [], hasKey: false, main: '', share: true, combine: false, registry: false } };
let view = 'today';
let found = null; // scan results (null = not scanned)
let drives = [];
let scanning = false;
let checked = [];
let notice = null;
let sortMode = 'size';

const COLORS = [['#E5383B', '#fff'], ['#2DD4BF', '#0B0B0D'], ['#F5A524', '#0B0B0D'], ['#A78BFA', '#0B0B0D'], ['#60A5FA', '#0B0B0D'], ['#F472B6', '#0B0B0D']];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function colorFor(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }
function initials(name) {
  const w = name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return (w[0][0] + (w[1] ? w[1][0] : (w[0][1] || ''))).toUpperCase();
}
function cover(name, w, h = w, key = null) {
  const attrs = `data-name="${esc(name)}" data-w="${w}" data-h="${h}"`;
  if (key && String(key).startsWith('icon-')) { // the game's own program icon: small, so show it centred on a tinted tile
    const [bg] = colorFor(name);
    return `<div class="cover icon" style="width:${w}px;height:${h}px;background:linear-gradient(135deg,${bg}66,#1B1B20 75%)"><img src="cover://${esc(key)}" alt="" data-icon="1" ${attrs} style="height:${Math.round(Math.min(w, h) * 0.6)}px;width:auto;max-width:80%"></div>`;
  }
  if (key) return `<img class="cover" src="cover://${esc(key)}" alt="" ${attrs} style="width:${w}px;height:${h}px;object-fit:cover">`;
  const [bg, fg] = colorFor(name);
  return `<div class="cover" style="width:${w}px;height:${h}px;font-size:${Math.round(Math.min(w, h) * 0.4)}px;background:${bg};color:${fg}">${esc(initials(name))}</div>`;
}
const gameCover = (g, w, h = w) => cover(g.name, w, h, g.coverKey);
function fmtBytes(b) {
  if (b == null) return '—';
  const gb = b / 1073741824;
  if (gb >= 100) return Math.round(gb) + ' GB';
  if (gb >= 1) return gb.toFixed(1) + ' GB';
  return Math.max(0, Math.round(b / 1048576)) + ' MB';
}
function ago(days) {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';
  if (days < 365) { const m = Math.floor(days / 30); return m + ' month' + (m === 1 ? '' : 's') + ' ago'; }
  const y = Math.floor(days / 365); return y + ' year' + (y === 1 ? '' : 's') + ' ago';
}
const pad = (n) => String(n).padStart(2, '0');
function fmt(ms) { const m = Math.floor(ms / 60000), h = Math.floor(m / 60); return h ? `${h}h ${pad(m % 60)}m` : `${m}m`; }
function clock(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; }
const endOf = (s) => (s.open ? Date.now() : s.end);
const overlap = (s, a, b) => Math.max(0, Math.min(endOf(s), b) - Math.max(s.start, a));
function bounds(daysAgo) {
  const a = new Date(); a.setHours(0, 0, 0, 0); a.setDate(a.getDate() - daysAgo);
  const b = new Date(a); b.setDate(b.getDate() + 1);
  return [a.getTime(), b.getTime()];
}
const playedOn = (a, b) => state.sessions.reduce((t, s) => t + overlap(s, a, b), 0);
function dayLabel(ts) {
  const [t0] = bounds(0), [y0] = bounds(1);
  if (ts >= t0) return 'Today';
  if (ts >= y0) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'long' });
}

function stats() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const [a, b] = bounds(i);
    days.push({ label: i ? new Date(a).toLocaleDateString(undefined, { weekday: 'short' }) : 'Today', ms: playedOn(a, b) });
  }
  let streak = 0;
  for (let i = days[6].ms > 0 ? 0 : 1; i < 365; i++) { const [a, b] = bounds(i); if (playedOn(a, b) > 0) streak++; else break; }
  const longest = state.sessions.reduce((m, s) => Math.max(m, endOf(s) - s.start), 0);
  return { days, today: days[6].ms, week: days.reduce((t, d) => t + d.ms, 0), streak, longest };
}
const gameById = (id) => state.games.find((g) => g.id === id);

/* ---------- views ---------- */
function renderToday() {
  const st = stats();
  const open = state.sessions.find((s) => s.open);
  const game = open && gameById(open.gameId);
  const total = game ? state.sessions.filter((s) => s.gameId === game.id).length : 0;
  const hero = game
    ? `<div class="card row hero">${gameCover(game, 184, 86)}
        <div class="grow"><div class="lbl" style="color:#FF6B6E">● Now playing</div><div class="big" style="font-size:34px">${esc(game.name)}</div>
        <div class="muted" style="font-size:15px">Started ${new Date(open.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${total} session${total === 1 ? '' : 's'} total</div></div>
        <div style="text-align:right"><div class="lbl">Session</div><div class="big" style="font-size:52px" id="timer" data-start="${open.start}">${clock(Date.now() - open.start)}</div></div></div>`
    : `<div class="card row hero idle"><div class="grow"><div class="lbl">Nothing running</div>
        <div class="big" style="font-size:30px">${state.games.length ? 'Launch a game to start tracking' : 'Add your first game'}</div>
        <div class="muted" style="font-size:15px">${state.games.length ? 'TrackerBean notices it automatically. You can keep this window closed.' : 'Go to Games and scan for the ones you have installed.'}</div></div>
        ${state.games.length ? '' : '<button class="btn red" data-act="nav" data-view="games">Set up games</button>'}</div>`;

  const max = Math.max(...st.days.map((d) => d.ms), 1);
  const bars = st.days.map((d, i) => `<div class="bar${i === 6 ? ' today' : ''}" title="${fmt(d.ms)}" style="height:${Math.max(2, (d.ms / max) * 100)}%"></div>`).join('');
  const labels = st.days.map((d, i) => `<span${i === 6 ? ' style="color:#fff"' : ''}>${esc(d.label)}</span>`).join('');
  const recent = [...state.sessions].sort((a, b) => b.start - a.start).slice(0, 5).map((s) => {
    const g = gameById(s.gameId); if (!g) return '';
    return `<div class="item">${gameCover(g, 76, 36)}<div class="grow"><b>${esc(g.name)}</b><div class="muted">${dayLabel(s.start)}${s.open ? ' · playing now' : ''}</div></div><b>${fmt(endOf(s) - s.start)}</b></div>`;
  }).join('') || '<div class="muted" style="padding:12px 0">No sessions yet. Play a game for a minute or more and it shows up here.</div>';

  return `<div class="h"><h1>Today</h1><span class="sub">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</span></div>
    ${accountBar()}
    ${hero}
    <div class="stats">
      <div class="card"><div class="lbl">Today</div><div class="big">${fmt(st.today)}</div></div>
      <div class="card"><div class="lbl">This week</div><div class="big" style="color:#F5A524">${fmt(st.week)}</div></div>
      <div class="card"><div class="lbl">Day streak</div><div class="big" style="color:#2DD4BF">${st.streak} day${st.streak === 1 ? '' : 's'}</div></div>
      <div class="card"><div class="lbl">Longest session</div><div class="big" style="color:#A78BFA">${fmt(st.longest)}</div></div>
    </div>
    ${friendsWidget()}
    <div class="two">
      <div class="card grow" style="flex:1.1"><div class="lbl">Last 7 days</div><div class="chart">${bars}</div><div class="labels">${labels}</div></div>
      <div class="card grow"><div class="lbl" style="padding-bottom:6px">Recent sessions</div>${recent}</div>
    </div>`;
}

function renderGames() {
  let banner = '';
  if (found !== null) {
    banner = found.length
      ? `<div class="card banner"><div class="row"><div class="grow"><b class="t">${found.length} game${found.length === 1 ? '' : 's'} found</b><div class="muted" style="font-size:15px">Add the ones you want tracked.</div></div>
          <button class="btn amber" data-act="add-all">Add all</button><button class="btn" data-act="dismiss">Dismiss</button></div>
          ${found.map((g, i) => `<div class="item">${cover(g.name, 92, 43, g.coverKey)}<div class="grow"><b>${esc(g.name)}</b><div class="muted">${esc(g.exes.join(', '))}</div></div><button class="btn" data-act="add-found" data-i="${i}">Add</button></div>`).join('')}</div>`
      : `<div class="card banner"><div class="row"><div class="grow"><b class="t">No new games found</b><div class="muted" style="font-size:15px">Checked ${checked.length} folder${checked.length === 1 ? '' : 's'}${checked.length ? ': ' + esc(checked.slice(0, 4).join(', ')) + (checked.length > 4 ? '...' : '') : ''}. Use "Add game folder" for a game that's elsewhere, or add a library folder in Settings.</div></div><button class="btn" data-act="dismiss">Dismiss</button></div></div>`;
  }
  if (notice) banner = `<div class="card banner"><div class="row"><div class="grow"><b class="t">${esc(notice)}</b></div><button class="btn" data-act="dismiss-notice">Dismiss</button></div></div>` + banner;
  const rows = state.games.map((g) => {
    const ss = state.sessions.filter((s) => s.gameId === g.id);
    const base = (g.baseMin || 0) * 60000; // hours played on Steam before TrackerBean, imported once
    const ms = base + ss.reduce((t, s) => t + (endOf(s) - s.start), 0);
    const last = ss.reduce((m, s) => Math.max(m, s.start), 0);
    return { g, ss, ms, last, base };
  }).sort((a, b) => b.ms - a.ms);
  const top = Math.max(...rows.map((r) => r.ms), 1);
  const cards = rows.map(({ g, ss, ms, last, base }) => {
    const [bg] = colorFor(g.name);
    return `<div class="card row" style="gap:16px">${gameCover(g, 128, 60)}
      <div class="grow"><b style="font-size:17px">${esc(g.name)}</b>
      <div class="muted">${last ? 'Last played ' + dayLabel(last) : 'Not played yet'} · ${ss.length} session${ss.length === 1 ? '' : 's'}</div>
      <div class="track"><div style="width:${(ms / top) * 100}%;background:${bg}"></div></div></div>
      <div style="text-align:right"><div class="big" style="font-size:30px">${fmt(ms)}</div>${base ? `<div class="muted" style="font-size:13px" title="Imported from Steam once, then only new playtime is added">incl. ${fmt(base)} from Steam</div>` : ''}<div class="acts"><button class="btn" data-act="cover-open" data-id="${g.id}">Change image</button><button class="btn${g.finishedAt ? ' on' : ''}" data-act="finish" data-id="${g.id}" title="Counts toward your Goals">${g.finishedAt ? '✓ Finished' : 'Mark finished'}</button><button class="btn ghost" data-act="remove" data-id="${g.id}">Remove</button></div></div></div>`;
  }).join('');
  const empty = `<div class="card empty"><div class="big">No games yet</div><div class="muted" style="font-size:15px">Scan your PC for installed games, or add one by picking its .exe file.</div></div>`;
  return `<div class="h"><h1>Games</h1><div class="row"><button class="btn" data-act="scan"${scanning ? ' disabled' : ''}>${scanning ? 'Scanning...' : 'Scan for games'}</button><button class="btn" data-act="sx-refresh" title="Import your Steam hours for games that don't have them yet"${sx.loading ? ' disabled' : ''}>${sx.loading ? 'Syncing...' : 'Sync Steam hours'}</button><button class="btn" data-act="pick">Add .exe</button><button class="btn red" data-act="pick-folder">+ Add game folder</button></div></div>
    ${banner}${rows.length ? `<div class="games">${cards}</div>` : empty}${renderCoverModal()}`;
}


function renderStorage() {
  const now = Date.now(), DAY = 864e5, IDLE = 60;
  const rows = state.games.map((g) => {
    const last = state.sessions.reduce((m, x) => (x.gameId === g.id ? Math.max(m, x.start) : m), 0);
    const days = Math.floor((now - (last || g.added || now)) / DAY);
    return { g, size: g.sizeBytes, days, last };
  });
  rows.sort(sortMode === 'size' ? (a, b) => (b.size ?? -1) - (a.size ?? -1) : (a, b) => b.days - a.days);
  const sized = rows.filter((r) => r.size != null);
  const total = sized.reduce((t, r) => t + r.size, 0);
  const big = sized.reduce((m, r) => (!m || r.size > m.size ? r : m), null);
  const idle = sized.filter((r) => r.days >= IDLE);
  const idleSize = idle.reduce((t, r) => t + r.size, 0);
  const top = Math.max(...sized.map((r) => r.size), 1);

  const driveHtml = drives.map((d) => {
    const mine = sized.filter((r) => r.g.installPath && r.g.installPath.toUpperCase().startsWith(d.root.toUpperCase())).reduce((t, r) => t + r.size, 0);
    const used = d.total - d.free, other = Math.max(0, used - mine);
    const pct = (n) => (n / d.total) * 100;
    return `<div class="drive"><div class="row"><b>${esc(d.root)}</b><span class="muted">${fmtBytes(d.free)} free of ${fmtBytes(d.total)}</span></div>
      <div class="stack"><div style="width:${pct(mine)}%;background:#E5383B"></div><div style="width:${pct(other)}%;background:#3A3A46"></div></div>
      <div class="legend"><span><i style="background:#E5383B"></i>Your games ${fmtBytes(mine)}</span><span><i style="background:#3A3A46"></i>Everything else ${fmtBytes(other)}</span></div></div>`;
  }).join('');

  const list = rows.map(({ g, size, days, last }) => {
    const isSteam = g.steamAppId && /steamapps[\\/]common/i.test(g.installPath || '');
    const chip = size != null && days >= IDLE ? `<span class="chip">Not played in ${days >= 365 ? Math.floor(days / 365) + 'y' : Math.floor(days / 30) + ' months'}</span>` : '';
    const sizeTxt = g.sizeMissing ? 'Missing' : size == null ? (state.sizing ? '...' : '—') : fmtBytes(size);
    const sub = g.sizeMissing ? 'Folder not found. It may have been uninstalled or moved.' : `${last ? 'Played ' + ago(days) : 'Never played'}`;
    return `<div class="card row" style="gap:16px">${gameCover(g, 128, 60)}
      <div class="grow"><b style="font-size:17px">${esc(g.name)}</b>${chip}
        <div class="muted">${esc(sub)}</div><div class="muted path" title="${esc(g.installPath || '')}">${esc(g.installPath || 'No install folder known')}</div>
        <div class="track"><div style="width:${size != null ? (size / top) * 100 : 0}%;background:${colorFor(g.name)[0]}"></div></div></div>
      <div style="text-align:right;min-width:150px"><div class="big" style="font-size:30px">${sizeTxt}</div>
        <div class="acts">${g.installPath && !g.sizeMissing ? `<button class="btn" data-act="open-folder" data-id="${g.id}">Open folder</button>` : ''}${isSteam ? `<button class="btn" data-act="uninstall" data-id="${g.id}">Uninstall</button>` : ''}</div></div></div>`;
  }).join('');

  const empty = `<div class="card empty"><div class="big">No games to measure</div><div class="muted" style="font-size:15px">Add games first, then come back to see how much space each one takes.</div><p><button class="btn red" data-act="nav" data-view="games">Go to Games</button></p></div>`;
  return `<div class="h"><h1>Storage</h1><div class="row">
      <button class="btn${sortMode === 'size' ? ' on' : ''}" data-act="sort" data-mode="size">Largest first</button>
      <button class="btn${sortMode === 'idle' ? ' on' : ''}" data-act="sort" data-mode="idle">Longest unplayed</button>
      <button class="btn" data-act="refresh-sizes"${state.sizing ? ' disabled' : ''}>${state.sizing ? 'Measuring...' : 'Refresh sizes'}</button></div></div>
    ${state.games.length ? `
    <div class="stats3">
      <div class="card"><div class="lbl">Games on disk</div><div class="big" style="color:#E5383B">${fmtBytes(total)}</div><div class="muted">${sized.length} of ${rows.length} measured</div></div>
      <div class="card"><div class="lbl">Biggest game</div><div class="big" style="color:#A78BFA">${big ? fmtBytes(big.size) : '—'}</div><div class="muted path">${big ? esc(big.g.name) : 'Measuring...'}</div></div>
      <div class="card"><div class="lbl">Not played in ${IDLE}+ days</div><div class="big" style="color:#F5A524">${fmtBytes(idleSize)}</div><div class="muted">${idle.length} game${idle.length === 1 ? '' : 's'} you could uninstall</div></div>
    </div>
    ${drives.length ? `<div class="card"><div class="lbl">Drives</div>${driveHtml}</div>` : ''}
    ${list}` : empty}`;
}

function updateText() {
  const u = state.update || {};
  return ({ disabled: 'updates work in the installed app', idle: 'not checked yet', checking: 'checking for updates...', current: "you're up to date",
    downloading: `downloading version ${esc(u.version || '')} (${u.percent || 0}%)`, ready: `version ${esc(u.version || '')} is ready to install`,
    error: "couldn't check for updates right now" }[u.status] || '');
}
function renderSettings() {
  const s = state.settings;
  const sw = (key, title, desc) => `<label class="switch"><input type="checkbox" data-act="setting" data-key="${key}" ${s[key] ? 'checked' : ''}><div><b>${title}</b><div class="muted" style="font-size:14px">${desc}</div></div></label>`;
  return `<div class="h"><h1>Settings</h1></div>
    <div class="card">
      ${sw('startWithWindows', 'Start with Windows', 'Launches quietly in the tray when you sign in, so every session is tracked.')}
      ${sw('closeToTray', 'Keep running in the tray when closed', 'Closing the window keeps tracking. Use Quit in the tray menu to stop it.')}
      ${sw('popupBlock', 'Pop-up blocker', 'Stops web pages and sign-in windows from opening extra windows or sending you elsewhere. Turn off to let links open in your normal browser.')}
      ${sw('quietWhileGaming', 'Quiet while gaming', 'Holds TrackerBean notifications (matches saved, challenge unlocks) until your game closes. Where-you-left-off reminders still show.')}
    </div>
    <div class="card"><div class="row"><div class="grow"><div class="lbl">Extra folders to scan</div>
      <div class="muted" style="font-size:14px;margin-top:6px">TrackerBean already checks Steam, Epic, GOG and Xbox folders on every drive. Add a folder here if your games live somewhere else (each game in its own sub-folder).</div></div>
      <button class="btn red" data-act="add-scan-folder">+ Add folder</button></div>
      ${(s.scanFolders || []).map((f, i) => `<div class="item"><div class="grow path">${esc(f)}</div><button class="btn ghost" data-act="remove-scan-folder" data-i="${i}">Remove</button></div>`).join('')}</div>
    <div class="card"><div class="row"><div class="grow"><div class="lbl">Updates</div>
      <div style="margin-top:6px;font-size:15px">TrackerBean ${esc((state.update && state.update.current) || '')} · ${updateText()}</div></div>
      ${state.update && state.update.status === 'ready' ? '<button class="btn red" data-act="update-install">Restart and update</button>' : `<button class="btn" data-act="update-check"${!state.update || ['disabled', 'checking', 'downloading'].includes(state.update.status) ? ' disabled' : ''}>Check for updates</button>`}</div></div>
    <div class="card"><div class="lbl">About tracking</div>
      <p class="muted" style="font-size:15px;margin:10px 0 0">Sessions shorter than one minute are ignored. All data stays on this PC.</p></div>`;
}

const MOODS = { great: ['😄', 'Great'], good: ['🙂', 'Good'], meh: ['😐', 'Meh'], bad: ['😤', 'Frustrating'] };
/* ---------- drafts (form values survive re-renders) ---------- */
const draft = {
  journal: { gameId: '', mood: 'good', text: '', left: false, images: [] },
  goal: { type: 'hours', target: 10, period: 'week', gameId: '', title: '' },
  quest: { gameId: '', goalMin: 120, mode: 'random' },
  statsRange: '30', journalFilter: '', lightbox: null, coverTerm: '', social: { account: '', friend: '' },
  montage: { manual: false, style: 'phonk', format: 'vertical', framing: 'blur', detect: 'vision', caption: '', autoVol: 'auto', fx: { slow: true, zoom: true, flash: true, grade: true, rgb: true }, autoSource: '', autoLen: '60', source: 'all', selected: [], transition: 'crossfade', res: '1080', fps: '60', trimLast: '0', clipVol: '100', musicVol: '60', musicName: '', name: '' },
};
let flash = null;
let coverModal = null; // { gameId, results, busy, searched }
function setDraft(path, val) { const parts = path.split('.'); let o = draft; while (parts.length > 1) o = o[parts.shift()]; o[parts[0]] = val; }
const gameOptions = (sel, blank) => (blank != null ? `<option value="">${esc(blank)}</option>` : '') + state.games.map((g) => `<option value="${g.id}"${g.id === sel ? ' selected' : ''}>${esc(g.name)}</option>`).join('');
const chip = (path, val, label, cur) => `<button class="btn${String(cur) === String(val) ? ' on' : ''}" data-act="draft-set" data-path="${path}" data-val="${esc(String(val))}">${label}</button>`;
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const hourName = (h) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const DOW = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/* ---------- stats ---------- */
function aggregate(from) {
  const hours = new Array(24).fill(0), dow = new Array(7).fill(0), days = new Map(), perGame = new Map();
  let sessions = 0, total = 0;
  for (const s of state.sessions) {
    const end = endOf(s), a = Math.max(s.start, from);
    if (end <= a) continue;
    sessions++; total += end - a;
    perGame.set(s.gameId, (perGame.get(s.gameId) || 0) + end - a);
    let t = a;
    while (t < end) {
      const d = new Date(t), he = new Date(d); he.setHours(d.getHours() + 1, 0, 0, 0);
      const nxt = Math.max(t + 1, Math.min(end, he.getTime())), ms = nxt - t;
      hours[d.getHours()] += ms; dow[(d.getDay() + 6) % 7] += ms;
      const k = dayKey(d); days.set(k, (days.get(k) || 0) + ms);
      t = nxt;
    }
  }
  return { hours, dow, days, perGame, sessions, total };
}
function streaksOf(days) {
  let first = Infinity;
  for (const s of state.sessions) first = Math.min(first, s.start);
  if (first === Infinity) return { best: 0, current: 0 };
  const d = new Date(first); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let best = 0, run = 0;
  while (d <= today) { if ((days.get(dayKey(d)) || 0) > 0) { run++; best = Math.max(best, run); } else run = 0; d.setDate(d.getDate() + 1); }
  let current = run;
  if ((days.get(dayKey(today)) || 0) === 0) { // today not played yet: streak counts back from yesterday
    current = 0; const y = new Date(today); y.setDate(y.getDate() - 1);
    while ((days.get(dayKey(y)) || 0) > 0) { current++; y.setDate(y.getDate() - 1); }
  }
  return { best, current };
}
const currentStreak = () => streaksOf(aggregate(0).days).current;

function renderStats() {
  const all = aggregate(0);
  if (!all.sessions) return `<div class="h"><h1>Stats</h1></div><div class="card empty"><div class="big">No stats yet</div><div class="muted" style="font-size:15px">Play a game for a minute or more and your numbers show up here.</div></div>`;
  const r = draft.statsRange;
  let from = 0;
  if (r !== 'all') { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (+r - 1)); from = d.getTime(); }
  const agg = r === 'all' ? all : aggregate(from);
  const st = streaksOf(all.days);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const mon = new Date(today); mon.setDate(mon.getDate() - ((today.getDay() + 6) % 7));
  const start = new Date(mon); start.setDate(start.getDate() - 26 * 7);
  let cells = '';
  for (let c = 0; c < 27; c++) for (let rr = 0; rr < 7; rr++) {
    const d = new Date(start); d.setDate(d.getDate() + c * 7 + rr);
    if (d > today) { cells += '<div class="hm" style="visibility:hidden"></div>'; continue; }
    const ms = all.days.get(dayKey(d)) || 0, h = ms / 3600000;
    const lv = h === 0 ? 0 : h < 1 ? 1 : h < 2.5 ? 2 : h < 4 ? 3 : 4;
    cells += `<div class="hm l${lv}" title="${esc(d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))}: ${fmt(ms)}"></div>`;
  }

  const peakH = agg.hours.indexOf(Math.max(...agg.hours)), peakD = agg.dow.indexOf(Math.max(...agg.dow));
  const maxH = Math.max(...agg.hours, 1), maxD = Math.max(...agg.dow, 1);
  const hourBars = agg.hours.map((ms, h) => `<div class="bar amber${ms > 0 && h === peakH ? ' peak' : ''}" title="${hourName(h)}: ${fmt(ms)}" style="height:${Math.max(2, (ms / maxH) * 100)}%"></div>`).join('');
  const hourLabels = agg.hours.map((_, h) => `<span>${h % 6 === 0 ? ['12a', '6a', '12p', '6p'][h / 6] : ''}</span>`).join('');
  const dowBars = agg.dow.map((ms, i) => `<div class="bar teal${ms > 0 && i === peakD ? ' peak' : ''}" title="${DOW[i]}: ${fmt(ms)}" style="height:${Math.max(2, (ms / maxD) * 100)}%"></div>`).join('');
  const dowLabels = DOW.map((d) => `<span>${d.slice(0, 3)}</span>`).join('');

  const top = [...agg.perGame.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topMax = top.length ? top[0][1] : 1;
  const topHtml = top.map(([id, ms]) => {
    const g = gameById(id); if (!g) return '';
    return `<div class="item">${gameCover(g, 76, 36)}<div class="grow"><b>${esc(g.name)}</b><div class="track"><div style="width:${(ms / topMax) * 100}%;background:${colorFor(g.name)[0]}"></div></div></div><b style="min-width:70px;text-align:right">${fmt(ms)}</b></div>`;
  }).join('');

  let longest = null;
  for (const s of state.sessions) { const d = endOf(s) - s.start; if (!longest || d > longest.d) longest = { d, s }; }
  let bestDay = null;
  for (const [k, ms] of all.days) if (!bestDay || ms > bestDay.ms) bestDay = { k, ms };
  const [by, bm, bd] = bestDay.k.split('-').map(Number);
  const lg = gameById(longest.s.gameId);
  const rangeNames = { 7: '7 days', 30: '30 days', 90: '90 days', all: 'all time' };

  return `<div class="h"><h1>Stats</h1><div class="row">${[['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['all', 'All time']].map(([v, l]) => chip('statsRange', v, l, r)).join('')}</div></div>
    <div class="stats">
      <div class="card"><div class="lbl">Playtime · ${rangeNames[r]}</div><div class="big" style="color:#E5383B">${fmt(agg.total)}</div></div>
      <div class="card"><div class="lbl">Sessions</div><div class="big" style="color:#F5A524">${agg.sessions}</div></div>
      <div class="card"><div class="lbl">Average session</div><div class="big" style="color:#2DD4BF">${agg.sessions ? fmt(agg.total / agg.sessions) : '0m'}</div></div>
      <div class="card"><div class="lbl">Games played</div><div class="big" style="color:#A78BFA">${agg.perGame.size}</div></div>
    </div>
    <div class="card"><div class="lbl">Last 6 months</div><div class="heat-wrap"><div class="heat">${cells}</div></div>
      <div class="legend" style="margin-top:10px"><span>Less</span>${[0, 1, 2, 3, 4].map((i) => `<span><i class="hm-l l${i}"></i></span>`).join('')}<span>More</span></div></div>
    <div class="two">
      <div class="card grow"><div class="lbl">When you play</div><div class="chart" style="height:130px;gap:4px">${hourBars}</div><div class="labels" style="gap:4px">${hourLabels}</div>
        <div class="muted" style="margin-top:8px">${agg.total ? `Most active around ${hourName(peakH)}.` : ''}</div></div>
      <div class="card grow"><div class="lbl">Which days</div><div class="chart" style="height:130px">${dowBars}</div><div class="labels">${dowLabels}</div>
        <div class="muted" style="margin-top:8px">${agg.total ? `${DOW[peakD]}s are your busiest.` : ''}</div></div>
    </div>
    <div class="two">
      <div class="card grow" style="flex:1.2"><div class="lbl" style="padding-bottom:6px">Top games · ${rangeNames[r]}</div>${topHtml || '<div class="muted">Nothing in this range.</div>'}</div>
      <div class="card grow"><div class="lbl" style="padding-bottom:6px">Records</div>
        <div class="item"><div class="grow"><div class="muted">Longest session</div><b>${fmt(longest.d)}</b> <span class="muted">${lg ? 'in ' + esc(lg.name) : ''} · ${fmtDate(longest.s.start)}</span></div></div>
        <div class="item"><div class="grow"><div class="muted">Biggest day</div><b>${fmt(bestDay.ms)}</b> <span class="muted">${fmtDate(new Date(by, bm, bd).getTime())}</span></div></div>
        <div class="item"><div class="grow"><div class="muted">Longest streak</div><b>${st.best} day${st.best === 1 ? '' : 's'}</b></div></div>
        <div class="item"><div class="grow"><div class="muted">Current streak</div><b style="color:#2DD4BF">${st.current} day${st.current === 1 ? '' : 's'}</b></div></div>
      </div>
    </div>`;
}

/* ---------- journal ---------- */
function renderJournal() {
  const d = draft.journal;
  const entries = [...(state.journal || [])].sort((a, b) => b.createdAt - a.createdAt).filter((e) => !draft.journalFilter || e.gameId === draft.journalFilter);
  const thumbs = d.images.map((n, i) => `<div class="thumb-wrap"><img class="thumb" src="media://${esc(n)}" alt=""><button class="x" data-act="j-rm-img" data-i="${i}" title="Remove">×</button></div>`).join('');
  const form = `<div class="card form">
    <div class="row" style="flex-wrap:wrap">
      <select data-draft="journal.gameId" data-rerender="1" aria-label="Game">${gameOptions(d.gameId, 'General (no game)')}</select>
      <div class="row" style="gap:6px">${Object.entries(MOODS).map(([k, [e, l]]) => chip('journal.mood', k, `${e} ${l}`, d.mood)).join('')}</div>
    </div>
    <textarea data-draft="journal.text" placeholder="What happened? A favourite moment, a boss that took ages, where you got stuck..." rows="4">${esc(d.text)}</textarea>
    ${thumbs ? `<div class="thumbs">${thumbs}</div>` : ''}
    <div class="row" style="flex-wrap:wrap">
      <button class="btn" data-act="j-pick-img"${d.images.length >= 6 ? ' disabled' : ''}>+ Screenshots</button>
      ${d.gameId ? `<label class="check"><input type="checkbox" data-draft="journal.left"${d.left ? ' checked' : ''}> Mark as where I left off (shown next time you launch it)</label>` : ''}
      <span class="grow"></span><button class="btn red" data-act="j-save">Save entry</button>
    </div></div>`;
  const list = entries.map((e) => {
    const g = e.gameId ? gameById(e.gameId) : null;
    const [emo, ml] = MOODS[e.mood] || MOODS.good;
    return `<div class="card entry"><div class="row">${g ? gameCover(g, 76, 36) : '<div class="cover" style="width:76px;height:36px;background:#26262D;color:#A8A8B3;font-size:14px">NOTE</div>'}
      <div class="grow"><b>${g ? esc(g.name) : 'General'}</b>${e.left ? '<span class="chip">Where I left off</span>' : ''}<div class="muted">${fmtDate(e.createdAt)} · ${new Date(e.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div></div>
      <span title="${esc(ml)}" style="font-size:24px">${emo}</span><button class="btn ghost" data-act="j-del" data-id="${e.id}">Delete</button></div>
      ${e.text ? `<div class="etext">${esc(e.text)}</div>` : ''}
      ${(e.images || []).length ? `<div class="thumbs">${e.images.map((n) => `<img class="thumb" src="media://${esc(n)}" alt="" data-act="lightbox" data-src="${esc(n)}">`).join('')}</div>` : ''}</div>`;
  }).join('') || '<div class="card empty"><div class="big">Your journal is empty</div><div class="muted" style="font-size:15px">Write about a moment you want to remember. Add screenshots to make it a scrapbook.</div></div>';
  return `<div class="h"><h1>Journal</h1><select data-draft="journalFilter" data-rerender="1" aria-label="Filter by game">${gameOptions(draft.journalFilter, 'All games')}</select></div>
    ${form}${list}${draft.lightbox ? `<div class="lightbox" data-act="close-lightbox"><img src="media://${esc(draft.lightbox)}" alt=""></div>` : ''}`;
}

/* ---------- goals ---------- */
const GOAL_TYPES = { hours: 'Play X hours', finish: 'Finish X games', newgames: 'Try X new games', streak: 'Play X days in a row', check: 'Custom checkbox goal' };
const PERIODS = { week: 'this week', month: 'this month', year: 'this year', none: 'no deadline' };
function goalTitle(g) {
  if (g.title) return g.title;
  const per = g.period && g.period !== 'none' ? ' ' + PERIODS[g.period] : '';
  const gm = g.gameId && gameById(g.gameId) ? ' of ' + gameById(g.gameId).name : '';
  if (g.type === 'hours') return `Play ${g.target}h${gm}${per}`;
  if (g.type === 'finish') return `Finish ${g.target} game${g.target === 1 ? '' : 's'}${per}`;
  if (g.type === 'newgames') return `Try ${g.target} new game${g.target === 1 ? '' : 's'}${per}`;
  if (g.type === 'streak') return `Play ${g.target} days in a row`;
  return 'Goal';
}
function goalProgress(g) {
  const inWin = (ts) => ts >= g.start && (g.end == null || ts < g.end);
  let value = 0, unit = '';
  if (g.type === 'hours') {
    const hi = g.end == null ? Infinity : g.end;
    value = state.sessions.filter((s) => !g.gameId || s.gameId === g.gameId).reduce((t, s) => t + overlap(s, g.start, hi), 0) / 3600000;
    value = Math.round(value * 10) / 10; unit = 'h';
  } else if (g.type === 'finish') {
    value = state.games.filter((x) => x.finishedAt && inWin(x.finishedAt)).length; unit = 'games';
  } else if (g.type === 'newgames') {
    value = state.games.filter((x) => { const f = state.sessions.filter((s) => s.gameId === x.id).reduce((m, s) => Math.min(m, s.start), Infinity); return f !== Infinity && inWin(f); }).length; unit = 'games';
  } else if (g.type === 'streak') {
    value = Math.min(g.target, currentStreak()); unit = 'days';
  } else { value = g.done ? 1 : 0; unit = ''; }
  const done = !!g.doneAt || value >= g.target;
  const expired = g.end != null && Date.now() >= g.end && !done;
  return { value, unit, done, expired };
}
const goalInflight = new Set();
function syncGoals() {
  for (const g of state.goals || []) {
    if (g.doneAt || goalInflight.has(g.id)) continue;
    if (g.type === 'check') continue; // set by the checkbox
    const p = goalProgress(g);
    if (p.done) {
      goalInflight.add(g.id);
      flash = `Goal complete: ${goalTitle(g)}`;
      window.api.updateGoal(g.id, { doneAt: Date.now() }).finally(() => goalInflight.delete(g.id));
    }
  }
}
const BINGO_LINES = (() => { const L = []; for (let i = 0; i < 4; i++) { L.push([0, 1, 2, 3].map((c) => i * 4 + c), [0, 1, 2, 3].map((r) => r * 4 + i)); } L.push([0, 5, 10, 15], [3, 6, 9, 12]); return L; })();

function renderGoals() {
  const f = draft.goal, goals = state.goals || [];
  const rows = goals.map((g) => ({ g, p: goalProgress(g) }));
  const active = rows.filter((r) => !r.p.done && !r.p.expired), finished = rows.filter((r) => r.p.done);
  const backlog = state.games.filter((g) => !state.sessions.some((s) => s.gameId === g.id));
  const card = ({ g, p }) => {
    const pct = Math.min(100, (p.value / g.target) * 100);
    const color = p.done ? '#2DD4BF' : p.expired ? '#5A5A66' : '#E5383B';
    const left = g.end != null && !p.done && !p.expired ? Math.max(0, Math.ceil((g.end - Date.now()) / 864e5)) : null;
    const status = p.done ? '<span class="chip ok">Done</span>' : p.expired ? '<span class="chip off">Missed</span>' : left != null ? `<span class="muted">${left} day${left === 1 ? '' : 's'} left</span>` : '';
    return `<div class="card"><div class="row"><div class="grow"><b style="font-size:17px">${esc(goalTitle(g))}</b> ${status}</div>
      ${g.type === 'check' ? `<button class="btn${g.done ? ' on' : ''}" data-act="g-check" data-id="${g.id}">${g.done ? '✓ Done' : 'Mark done'}</button>` : `<b>${p.value} / ${g.target} ${p.unit}</b>`}
      <button class="btn ghost" data-act="g-del" data-id="${g.id}">Delete</button></div>
      ${g.type === 'check' ? '' : `<div class="pbar"><div style="width:${pct}%;background:${color}"></div></div>`}</div>`;
  };
  const form = `<div class="card form"><div class="lbl">New goal</div><div class="row" style="flex-wrap:wrap">
    <select data-draft="goal.type" data-rerender="1" aria-label="Goal type">${Object.entries(GOAL_TYPES).map(([k, l]) => `<option value="${k}"${f.type === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
    ${f.type !== 'check' ? `<input type="number" min="1" max="10000" data-draft="goal.target" value="${esc(f.target)}" style="width:90px" aria-label="Target">` : ''}
    ${['hours', 'finish', 'newgames'].includes(f.type) ? `<select data-draft="goal.period" aria-label="Period">${Object.entries(PERIODS).map(([k, l]) => `<option value="${k}"${f.period === k ? ' selected' : ''}>${l}</option>`).join('')}</select>` : ''}
    ${f.type === 'hours' ? `<select data-draft="goal.gameId" aria-label="Game">${gameOptions(f.gameId, 'Any game')}</select>` : ''}
    <input type="text" data-draft="goal.title" value="${esc(f.title)}" placeholder="${f.type === 'check' ? 'What do you want to do?' : 'Name (optional)'}" maxlength="80" style="flex:1;min-width:180px">
    <button class="btn red" data-act="g-add">Add goal</button></div></div>`;
  const b = state.bingo;
  let bingoHtml = '<div class="muted">Loading your card...</div>', lines = 0;
  if (b) {
    const hit = new Set();
    for (const L of BINGO_LINES) if (L.every((i) => b.squares[i].done)) { lines++; L.forEach((i) => hit.add(i)); }
    bingoHtml = `<div class="bingo">${b.squares.map((q, i) => `<button class="bsq${q.done ? ' done' : ''}${hit.has(i) ? ' line' : ''}" data-act="bingo" data-i="${i}">${esc(q.text)}</button>`).join('')}</div>`;
  }
  return `<div class="h"><h1>Goals</h1><span class="sub">${active.length} active · ${finished.length} done</span></div>
    ${form}
    ${active.length ? active.map(card).join('') : '<div class="card empty" style="padding:28px"><div class="muted" style="font-size:15px">No active goals. Add one above, like "Play 10 hours this week" or "Finish 3 games this year".</div></div>'}
    <div class="card"><div class="row"><div class="grow"><div class="lbl">Backlog countdown</div><div class="big" style="color:#F5A524">${backlog.length} unplayed</div></div>
      <div class="muted grow" style="text-align:right">${backlog.length ? esc(backlog.slice(0, 4).map((g) => g.name).join(', ')) + (backlog.length > 4 ? '...' : '') : 'Everything you own has been played. Nice.'}</div></div></div>
    <div class="card"><div class="row"><div class="grow"><div class="lbl">Game bingo</div><div class="muted" style="font-size:14px">Tick a square when you do it. ${lines ? `<b style="color:#E5383B">BINGO x${lines}!</b>` : ''}</div></div><button class="btn" data-act="bingo-new">New card</button></div>${bingoHtml}</div>
    ${finished.length ? `<div class="lbl">Completed</div>${finished.map(card).join('')}` : ''}`;
}

/* ---------- challenge (unlock chain) ---------- */
function renderQuest() { return renderQuestMain() + backlogCard(); }
function renderQuestMain() {
  const q = state.quest || {}, d = draft.quest;
  const ex = new Set(q.excluded || []);
  const included = state.games.filter((g) => !ex.has(g.id));
  const head = '<div class="h"><h1>Challenge</h1><span class="sub">Unlock chain</span></div>';
  const rule = '<div class="muted" style="font-size:14px">Nothing is ever blocked. Play any game you like. Only time on the current target counts toward the challenge.</div>';
  const picker = `<div class="card"><div class="lbl">Games in this challenge</div>
    <div class="muted" style="font-size:14px;margin:6px 0 12px">Untick a game to leave it out. You can still play it any time, it just won't be picked or unlocked.</div>
    <div class="picks">${state.games.map((g) => {
      const cur = q.current && q.current.gameId === g.id;
      return `<label class="pickrow${ex.has(g.id) ? ' off' : ''}">${gameCover(g, 60, 28)}<span class="grow">${esc(g.name)}${cur ? ' <span class="muted">(current target)</span>' : ''}</span><input type="checkbox" data-act="q-exclude" data-id="${g.id}"${ex.has(g.id) ? '' : ' checked'}${cur ? ' disabled' : ''} aria-label="Include ${esc(g.name)}"></label>`;
    }).join('')}</div></div>`;
  if (included.length < 2) return `${head}<div class="card empty"><div class="big">Include at least 2 games</div><div class="muted" style="font-size:15px">${state.games.length < 2 ? 'Add more games first.' : 'Tick more games below, or add more games.'}</div>${state.games.length < 2 ? '<p><button class="btn red" data-act="nav" data-view="games">Go to Games</button></p>' : ''}</div>${state.games.length >= 2 ? picker : ''}`;

  const done = new Set((q.completed || []).map((c) => c.gameId));
  const locked = included.filter((g) => !done.has(g.id) && !(q.current && q.current.gameId === g.id));
  const completedHtml = (q.completed || []).map((c) => { const g = gameById(c.gameId); return g ? `<div class="tile ok">${gameCover(g, 150, 70)}<b>✓ ${esc(g.name)}</b><span class="muted">${fmtDate(c.at)}</span></div>` : ''; }).join('');
  const lockedHtml = locked.map((g) => q.mode === 'random'
    ? `<div class="tile lock"><div class="cover" style="width:150px;height:70px;background:#1B1B20;color:#5A5A66;font-size:30px">?</div><b>🔒 Mystery game</b></div>`
    : `<div class="tile lock dim">${gameCover(g, 150, 70)}<b>🔒 ${esc(g.name)}</b></div>`).join('');
  const chain = (completedHtml || lockedHtml) ? `<div class="lbl" style="margin-top:4px">Your chain</div><div class="tiles">${completedHtml}${lockedHtml}</div>` : '';

  if (q.finished) return `${head}<div class="card row hero"><div class="grow"><div class="lbl" style="color:#2DD4BF">Challenge complete</div><div class="big" style="font-size:34px">You unlocked everything 🎉</div><div class="muted" style="font-size:15px">${(q.completed || []).length} games worked through.</div></div><button class="btn red" data-act="q-reset">Start a new challenge</button></div>${chain}${picker}`;

  if (q.pending) {
    return `${head}<div class="card row hero"><div class="grow"><div class="lbl" style="color:#F5A524">Goal reached</div><div class="big" style="font-size:34px">Choose your next unlock</div><div class="muted" style="font-size:15px">Pick any game from your list. You can still play the others whenever you want.</div></div></div>
      <div class="tiles">${locked.map((g) => `<button class="tile pick" data-act="q-choose" data-id="${g.id}">${gameCover(g, 150, 70)}<b>${esc(g.name)}</b><span class="btn red">Unlock</span></button>`).join('')}</div>${chain}${picker}`;
  }

  if (q.current) {
    const g = gameById(q.current.gameId);
    const goalMs = q.goalMin * 60000, prog = Math.min(goalMs, progressNow(q)), pct = (prog / goalMs) * 100;
    const fresh = q.lastUnlock && Date.now() - q.lastUnlock.at < 36e5 && q.lastUnlock.gameId === q.current.gameId;
    const canReroll = q.mode === 'random' && progressNow(q) < 10 * 60000 && locked.length > 0;
    return `${head}${fresh ? '<div class="card banner"><b class="t">🔓 New game unlocked!</b></div>' : ''}
      <div class="card row hero" style="gap:22px">${g ? gameCover(g, 184, 86) : ''}
        <div class="grow"><div class="lbl" style="color:#FF6B6E">Current target</div><div class="big" style="font-size:34px">${g ? esc(g.name) : 'Unknown game'}</div>
          <div class="pbar" style="margin-top:12px;height:12px"><div style="width:${pct}%;background:#E5383B"></div></div>
          <div class="muted" style="font-size:15px;margin-top:8px">${fmt(prog)} of ${fmt(goalMs)} · ${fmt(goalMs - prog)} to go · then ${q.mode === 'random' ? 'a random game unlocks' : 'you choose the next one'}</div></div>
        <div class="row" style="flex-direction:column;align-items:stretch">${canReroll ? '<button class="btn" data-act="q-reroll">Reroll target</button>' : ''}<button class="btn ghost" data-act="q-reset">Quit challenge</button></div></div>
      ${rule}${chain}${picker}`;
  }

  if (!d.gameId || !included.some((g) => g.id === d.gameId)) d.gameId = included[0].id;
  const opts = included.map((g) => `<option value="${g.id}"${g.id === d.gameId ? ' selected' : ''}>${esc(g.name)}</option>`).join('');
  return `${head}
    <div class="card"><div class="lbl">How it works</div><p style="margin:8px 0 0;font-size:15px;line-height:1.5">Pick a game to start with and a play-time goal. Play that game until you hit the goal and the next game unlocks, either at random or one you choose. You can keep playing other games the whole time, they just don't count.</p></div>
    <div class="card form"><div class="lbl">Start a challenge</div>
      <div class="row" style="flex-wrap:wrap"><span class="muted">Start with</span><select data-draft="quest.gameId" aria-label="Starting game">${opts}</select></div>
      <div class="row" style="flex-wrap:wrap"><span class="muted">Play for</span>${[30, 60, 120, 180, 300].map((m) => chip('quest.goalMin', m, fmt(m * 60000), d.goalMin)).join('')}
        <input type="number" min="5" max="6000" data-draft="quest.goalMin" value="${esc(d.goalMin)}" style="width:90px" aria-label="Minutes"><span class="muted">minutes</span></div>
      <div class="row" style="flex-wrap:wrap"><span class="muted">Then unlock</span>${chip('quest.mode', 'random', 'A random game', d.mode)}${chip('quest.mode', 'choose', 'I choose', d.mode)}</div>
      <div><button class="btn red" data-act="q-start">Start challenge</button></div></div>${picker}`;
}
const progressNow = (q) => {
  if (!q.current) return 0;
  const now = Date.now();
  return state.sessions.filter((s) => s.gameId === q.current.gameId).reduce((t, s) => t + Math.max(0, endOf(s) - Math.max(s.start, q.current.since)), 0);
};

function renderCoverModal() {
  if (!coverModal) return '';
  const g = gameById(coverModal.gameId);
  if (!g) return '';
  const res = coverModal.results.map((r) => `<button class="tile pick" data-act="cover-use" data-key="${esc(r.key)}">${cover(r.name, 150, 70, r.key)}<b>${esc(r.name)}</b></button>`).join('');
  return `<div class="modal-bg"><div class="modal card">
    <div class="row"><div class="grow"><div class="lbl">Change image</div><div class="big" style="font-size:28px">${esc(g.name)}</div></div>${gameCover(g, 128, 60)}</div>
    <div class="row" style="margin-top:16px"><input type="text" data-draft="coverTerm" value="${esc(draft.coverTerm)}" placeholder="Search Steam for a game" style="flex:1" aria-label="Search Steam"><button class="btn red" data-act="cover-search"${coverModal.busy ? ' disabled' : ''}>${coverModal.busy ? 'Searching...' : 'Search Steam'}</button></div>
    ${res ? `<div class="tiles" style="margin-top:14px">${res}</div>` : `<div class="muted" style="margin:14px 0">${coverModal.searched ? 'No matches found. Try a shorter name, or choose your own image below.' : 'Search by name and click the picture you want.'}</div>`}
    <div class="row" style="margin-top:16px;flex-wrap:wrap"><button class="btn" data-act="cover-file">Choose image file...</button><button class="btn" data-act="cover-reset">Reset to automatic</button><span class="grow"></span><button class="btn" data-act="cover-close">Close</button></div>
  </div></div>`;
}


/* ---------- montage ---------- */
const mont = { loaded: false, loading: false, info: null, clips: [], meta: {}, shown: 24, job: null };
const clipById = (id) => mont.clips.find((c) => c.id === id);
const fmtSec = (s) => { const t = Math.round(s); return `${Math.floor(t / 60)}:${pad(t % 60)}`; };
const clipTime = (c) => `${new Date(c.mtime).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${new Date(c.mtime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

// Medal saves a clip a moment after it happens, so a clip belongs to the session it was saved during.
function sessionForClip(c) {
  const now = Date.now();
  return state.sessions.find((s) => c.mtime >= s.start - 30000 && c.mtime <= (s.open ? now : s.end) + 300000) || null;
}
// Which game a clip belongs to. Medal files clips in a folder named after the game, which is more reliable than timing,
// so match the folder name to your games first (CS2 / CS:GO / Counter-Strike all count as the same), then fall back to the session.
const normName = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isCsName = (n) => /counterstrike|cs2|csgo/.test(n);
function gameKeyForClip(c) {
  const f = normName(c.folder);
  if (f) {
    for (const g of state.games) {
      const n = normName(g.name);
      if (n && (n === f || (n.length >= 4 && f.length >= 4 && (n.includes(f) || f.includes(n))) || (isCsName(n) && isCsName(f)))) return 'game:' + g.id;
    }
  }
  const s = sessionForClip(c);
  if (s) return 'game:' + s.gameId;
  return f && f !== normName('Clips') && f !== normName('Medal') ? 'folder:' + c.folder : null;
}
function montageView() {
  const d = draft.montage, sess = new Map(), groups = new Map();
  for (const c of mont.clips) {
    const s = sessionForClip(c);
    if (s) { sess.set(c.id, s); if (!groups.has(s.id)) groups.set(s.id, { s, n: 0 }); groups.get(s.id).n++; }
  }
  if (d.source !== 'all' && d.source !== 'none' && !groups.has(d.source)) d.source = 'all';
  let list;
  if (d.source === 'all') list = mont.clips;
  else if (d.source === 'none') list = mont.clips.filter((c) => !sess.has(c.id));
  else list = mont.clips.filter((c) => sess.has(c.id) && sess.get(c.id).id === d.source).sort((a, b) => a.mtime - b.mtime);
  return { sess, groups, list };
}
async function loadMontage() {
  mont.loading = true; render();
  try {
    mont.info = await window.api.montageInfo();
    draft.montage.musicName = mont.info.music || '';
    mont.clips = mont.info.folder ? await window.api.montageScan() : [];
    try { cs2ui.data = await window.api.cs2Data(); } catch { /* no match data */ }
  } finally { mont.loaded = true; mont.loading = false; render(); }
  ensureMeta();
}
async function ensureMeta() {
  const { list } = montageView();
  const ids = list.slice(0, mont.shown).map((c) => c.id).concat(draft.montage.selected).filter((id, i, a) => !(id in mont.meta) && a.indexOf(id) === i);
  for (let i = 0; i < ids.length; i += 12) {
    const res = (await window.api.montageMeta(ids.slice(i, i + 12))) || {};
    for (const id of ids.slice(i, i + 12)) mont.meta[id] = res[id] || { duration: 0 };
    softRender();
  }
}
function estimateLength(clips, d) {
  const ds = clips.map((c) => mont.meta[c.id] && mont.meta[c.id].duration).filter(Boolean);
  if (!ds.length) return 0;
  const trim = +d.trimLast, keeps = ds.map((x) => (trim > 0 ? Math.min(x, trim) : x));
  let X = d.transition === 'cut' || keeps.length < 2 ? 0 : Math.min(0.6, Math.min(...keeps) / 3);
  if (X < 0.1) X = 0;
  return keeps.reduce((a, b) => a + b, 0) - X * (keeps.length - 1);
}

function renderMontage() {
  const d = draft.montage, info = mont.info;
  const head = `<div class="h"><h1>Montage</h1><div class="row"><button class="btn" data-act="m-rescan">Rescan</button><button class="btn" data-act="m-folder">Change clips folder</button></div></div>`;
  if (mont.loading || !info) return `${head}<div class="card empty"><div class="muted" style="font-size:15px">Looking for your clips...</div></div>`;
  if (!info.folder) return `${head}<div class="card empty"><div class="big">Where are your clips saved?</div><div class="muted" style="font-size:15px">I couldn't find Medal's folder automatically. Check Medal's settings for where it saves clips, then pick that folder.</div><p><button class="btn red" data-act="m-folder">Choose clips folder</button></p></div>`;

  const { sess, groups, list } = montageView();
  const selClips = d.selected.map(clipById).filter(Boolean);
  const est = estimateLength(selClips, d), job = mont.job;

  const selRows = selClips.map((c, i) => {
    const m = mont.meta[c.id], s = sess.get(c.id), g = s && gameById(s.gameId);
    const keep = m && m.duration ? (+d.trimLast > 0 ? Math.min(m.duration, +d.trimLast) : m.duration) : 0;
    return `<div class="selrow"><b class="idx">${i + 1}</b><span class="grow">${esc(g ? g.name : c.folder)} <span class="muted">· ${clipTime(c)}</span></span><span class="muted">${keep ? fmtSec(keep) : ''}</span>
      <button class="btn ghost" data-act="m-up" data-i="${i}" aria-label="Move up"${i === 0 ? ' disabled' : ''}>▲</button><button class="btn ghost" data-act="m-down" data-i="${i}" aria-label="Move down"${i === selClips.length - 1 ? ' disabled' : ''}>▼</button><button class="btn ghost" data-act="m-rm" data-i="${i}" aria-label="Remove">✕</button></div>`;
  }).join('');

  let status = '';
  if (job && job.busy) status = `<div class="card banner"><div class="row"><div class="grow"><b class="t">${job.stage === 'analyze' ? 'Finding the best moments...' : 'Making your montage...'} <span id="mpct">${Math.round((job.pct || 0) * 100)}%</span></b><div class="pbar"><div id="mprog" style="width:${(job.pct || 0) * 100}%;background:#F5A524"></div></div><div class="muted">This can take a few minutes. You can use other tabs, but keep TrackerBean open.</div></div><button class="btn" data-act="m-cancel">Cancel</button></div></div>`;
  else if (job && job.ok) status = `<div class="card banner" style="border-color:#14594F;background:#0A1A18"><div class="row"><div class="grow"><b class="t" style="color:#2DD4BF">Montage ready (${fmtSec(job.total)})${job.used ? (job.unit === 'moments' ? ' · ' + job.used + ' moments from ' + job.of + ' clip' + (job.of === 1 ? '' : 's') : ' · used ' + job.used + ' of ' + job.of + ' clips') : ''}</b><div class="muted">${esc(job.output)}</div>${job.note ? `<div class="muted">${esc(job.note)}</div>` : ''}</div><button class="btn red" data-act="m-open">Play</button><button class="btn" data-act="m-show">Show in folder</button><button class="btn ghost" data-act="m-dismiss">Dismiss</button></div></div>`;
  else if (job && job.error) status = `<div class="card banner"><div class="row"><div class="grow"><b class="t">${esc(job.error)}</b></div><button class="btn" data-act="m-dismiss">Dismiss</button></div></div>`;

  const busy = !!(job && job.busy);
  const builder = `<div class="card form">
    <div class="row"><div class="grow"><div class="lbl">Your montage</div><div class="muted" style="font-size:14px">${selClips.length ? `${selClips.length} clip${selClips.length === 1 ? '' : 's'}${est ? ' · about ' + fmtSec(est) : ''}` : 'Click clips below to add them, in the order you want them to play.'}</div></div>
      <button class="btn" data-act="m-sort"${selClips.length < 2 ? ' disabled' : ''}>Sort by time</button><button class="btn" data-act="m-clear"${selClips.length ? '' : ' disabled'}>Clear</button></div>
    ${selRows ? `<div class="sellist">${selRows}</div>` : ''}
    <div class="opts">
      <div class="row" style="flex-wrap:wrap"><span class="opt">Between clips</span>${chip('montage.transition', 'cut', 'Cuts', d.transition)}${chip('montage.transition', 'crossfade', 'Crossfade', d.transition)}${chip('montage.transition', 'fadeblack', 'Fade to black', d.transition)}</div>
      <div class="row" style="flex-wrap:wrap"><span class="opt">Trim each clip</span>${chip('montage.trimLast', '0', 'Keep all', d.trimLast)}${chip('montage.trimLast', '10', 'Last 10s', d.trimLast)}${chip('montage.trimLast', '15', 'Last 15s', d.trimLast)}${chip('montage.trimLast', '20', 'Last 20s', d.trimLast)}</div>
      <div class="row" style="flex-wrap:wrap"><span class="opt">Quality</span>${chip('montage.res', '720', '720p', d.res)}${chip('montage.res', '1080', '1080p', d.res)}${chip('montage.res', '1440', '1440p', d.res)}<span class="opt" style="margin-left:10px">Frame rate</span>${chip('montage.fps', '30', '30 fps', d.fps)}${chip('montage.fps', '60', '60 fps', d.fps)}</div>
      <div class="row" style="flex-wrap:wrap"><span class="opt">Game sound</span>${chip('montage.clipVol', '100', 'Full', d.clipVol)}${chip('montage.clipVol', '35', 'Low', d.clipVol)}${chip('montage.clipVol', '0', 'Off', d.clipVol)}</div>
      <div class="row" style="flex-wrap:wrap"><span class="opt">Music</span>${d.musicName ? `<b>${esc(d.musicName)}</b><button class="btn ghost" data-act="m-music-clear">Remove</button>${chip('montage.musicVol', '35', 'Quiet', d.musicVol)}${chip('montage.musicVol', '60', 'Medium', d.musicVol)}${chip('montage.musicVol', '90', 'Loud', d.musicVol)}` : '<button class="btn" data-act="m-music">+ Choose music file</button><span class="muted">optional</span>'}</div>
      <div class="row" style="flex-wrap:wrap"><span class="opt">Name</span><input type="text" data-draft="montage.name" value="${esc(d.name)}" placeholder="Montage" maxlength="60" style="width:240px"><span class="grow"></span>
        <span class="muted path" title="${esc(info.outputDir)}">Saves to ${esc(info.outputDir)}</span><button class="btn ghost" data-act="m-output">Change</button></div>
    </div>
    <div><button class="btn red" data-act="m-make"${!selClips.length || busy || !info.hasFfmpeg ? ' disabled' : ''}>${busy ? 'Working...' : 'Make montage'}</button></div></div>`;

  const options = [...groups.values()].sort((a, b) => b.s.start - a.s.start).map(({ s, n }) => {
    const g = gameById(s.gameId);
    return `<option value="${s.id}"${d.source === s.id ? ' selected' : ''}>${esc(g ? g.name : 'Game')} · ${new Date(s.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${new Date(s.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${n} clip${n === 1 ? '' : 's'}</option>`;
  }).join('');
  const unmatched = mont.clips.filter((c) => !sess.has(c.id)).length;
  const shownList = list.slice(0, mont.shown);
  const cards = shownList.map((c) => {
    const m = mont.meta[c.id], idx = d.selected.indexOf(c.id), s = sess.get(c.id), g = s && gameById(s.gameId);
    const bad = m && !m.duration;
    return `<button class="clip${idx >= 0 ? ' sel' : ''}" data-act="m-toggle" data-id="${c.id}"${bad ? ' disabled title="This file could not be read"' : ''}>
      <div class="cthumb">${m && m.thumb ? `<img src="media://t-${c.id}.jpg" alt="">` : `<span class="muted">${m ? (bad ? 'Unreadable' : '') : '...'}</span>`}${m && m.duration ? `<span class="dur">${fmtSec(m.duration)}</span>` : ''}${idx >= 0 ? `<span class="num">${idx + 1}</span>` : ''}</div>
      <div class="cmeta"><b>${clipTime(c)}</b><span class="muted path">${esc(g ? g.name : c.folder)}</span></div></button>`;
  }).join('');

  const latest = [...groups.values()].sort((a, b) => b.s.start - a.s.start);
  const csMatches = ((cs2ui.data && cs2ui.data.matches) || []).filter((m) => m.kills).slice(0, 12);
  const gameCounts = new Map(); // 'game:<id>' or 'folder:<name>' -> number of clips
  for (const c of mont.clips) { const k = gameKeyForClip(c); if (k) gameCounts.set(k, (gameCounts.get(k) || 0) + 1); }
  const validSource = d.autoSource === 'recent' || gameCounts.has(d.autoSource) || groups.has(d.autoSource) || csMatches.some((m) => 'match:' + m.id === d.autoSource);
  if (!d.autoSource || !validSource) d.autoSource = latest.length ? latest[0].s.id : 'recent';
  const csOptions = csMatches.map((m) => `<option value="match:${m.id}"${d.autoSource === 'match:' + m.id ? ' selected' : ''}>CS2 highlights · ${esc(m.map)} ${m.score.you}-${m.score.enemy} (${resWord(m.result)}) · ${new Date(m.startedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${new Date(m.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</option>`).join('');
  const gameOpts = [...gameCounts.entries()].filter(([k, n]) => k.startsWith('game:') || n >= 2).sort((a, b) => b[1] - a[1]).map(([k, n]) => { const g = k.startsWith('game:') ? gameById(k.slice(5)) : null; const nm = g ? g.name : k.slice(7); return `<option value="${esc(k)}"${d.autoSource === k ? ' selected' : ''}>All my ${esc(nm)} clips · ${n} clip${n === 1 ? '' : 's'}</option>`; }).join('');
  const autoOptions = csOptions + gameOpts + latest.map(({ s, n }) => {
    const g = gameById(s.gameId);
    return `<option value="${s.id}"${d.autoSource === s.id ? ' selected' : ''}>${esc(g ? g.name : 'Game')} · ${new Date(s.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${new Date(s.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${n} clip${n === 1 ? '' : 's'}</option>`;
  }).join('') + `<option value="recent"${d.autoSource === 'recent' ? ' selected' : ''}>My ${Math.min(20, mont.clips.length)} newest clips</option>`;
  const musicBits = d.musicName ? `<b>${esc(d.musicName)}</b><button class="btn ghost" data-act="m-music-clear">Remove</button>` : '<button class="btn" data-act="m-music">+ Choose music file</button><span class="muted">optional</span>';
  const autoCard = mont.clips.length ? `<div class="card form" style="background:linear-gradient(100deg,#2A1014,#151518 70%);border-color:#4A1A20">
    <div><div class="lbl" style="color:#FF6B6E">Automatic montage</div><div class="big" style="font-size:30px">One-click highlight reel</div>
      <div class="muted" style="font-size:15px;margin-top:4px">It finds the best moments in your clips, cuts them on the beat and adds slow-mo, zoom punches, glitch and flashes. No editing needed.</div></div>
    <div class="row" style="flex-wrap:wrap"><span class="opt">Clips from</span><select data-draft="montage.autoSource" aria-label="Clips for the automatic montage">${autoOptions}</select></div>
    <div class="row" style="flex-wrap:wrap"><span class="opt">Style</span>${chip('montage.style', 'phonk', 'Phonk (aggressive)', d.style)}${chip('montage.style', 'hype', 'Hype (fast cuts)', d.style)}${chip('montage.style', 'smooth', 'Cinematic (slow-mo)', d.style)}${chip('montage.style', 'clean', 'Clean (crossfades)', d.style)}</div>
    ${d.style !== 'clean' ? `<div class="row" style="flex-wrap:wrap"><span class="opt">Format</span>${chip('montage.format', 'vertical', 'Vertical 9:16 (TikTok)', d.format)}${chip('montage.format', 'wide', 'Widescreen 16:9', d.format)}${d.format !== 'wide' ? `<span class="opt" style="margin-left:10px">Framing</span>${chip('montage.framing', 'blur', 'Blurred bars', d.framing)}${chip('montage.framing', 'fill', 'Fill (crop sides)', d.framing)}` : ''}</div>
    <div class="row" style="flex-wrap:wrap"><span class="opt">Find highlights</span>${chip('montage.detect', 'vision', 'AI vision (sees kills)', d.detect)}${chip('montage.detect', 'audio', 'Sound only', d.detect)}${d.detect === 'vision' ? (info.hasKey ? '<span class="muted">API key saved</span><button class="btn ghost" data-act="m-key-clear">Remove key</button>' : '<input type="password" id="m-key" placeholder="Anthropic API key (sk-ant-...)" style="width:260px" autocomplete="off"><button class="btn" data-act="m-key-save">Save key</button>') : ''}</div>
    <div class="row" style="flex-wrap:wrap"><span class="opt">Caption</span><input type="text" data-draft="montage.caption" value="${esc(d.caption)}" placeholder="POV: you hit the clutch (optional)" maxlength="80" style="width:300px"></div>
    <div class="row" style="flex-wrap:wrap"><span class="opt">Effects</span>${[['slow', 'Slow-mo on the big moment'], ['zoom', 'Beat zoom + shake'], ['rgb', 'RGB glitch'], ['flash', 'Flash on each cut'], ['grade', 'Colour boost + vignette']].map(([k, l]) => `<label class="check"><input type="checkbox" data-draft="montage.fx.${k}"${d.fx[k] ? ' checked' : ''}> ${l}</label>`).join('')}</div>` : ''}
    <div class="row" style="flex-wrap:wrap"><span class="opt">How long</span>${chip('montage.autoLen', '30', 'About 30 seconds', d.autoLen)}${chip('montage.autoLen', '60', 'About 1 minute', d.autoLen)}${chip('montage.autoLen', '120', 'About 2 minutes', d.autoLen)}${chip('montage.autoLen', 'song', 'Fill the whole song', d.autoLen)}</div>
    ${d.autoLen === 'song' ? (d.musicName ? '<div class="muted" style="font-size:14px">Uses as many of your best moments as it takes to fill <b>' + esc(d.musicName) + '</b>. Pick "All my ... clips" above to give it plenty to choose from.</div>' : '<div class="muted" style="font-size:14px;color:#F5A524">Choose a song below first. The montage is made as long as the song.</div>') : ''}
    <div class="row" style="flex-wrap:wrap"><span class="opt">Game sound</span>${chip('montage.autoVol', 'auto', 'Auto', d.autoVol)}${chip('montage.autoVol', '100', 'Full', d.autoVol)}${chip('montage.autoVol', '35', 'Low', d.autoVol)}${chip('montage.autoVol', '0', 'Off', d.autoVol)}<span class="muted">${d.autoVol === 'auto' ? 'quiet under a song, louder with the built-in beat' : 'gunshots and in-game audio from your clips'}</span></div>
    <div class="row" style="flex-wrap:wrap"><span class="opt">Music</span>${musicBits}${d.style !== 'clean' && !d.musicName ? '<span class="muted">no song? a beat is generated for you. A song with a strong beat looks best</span>' : ''}</div>
    <div><button class="btn red" data-act="m-auto" style="font-size:16px;padding:12px 22px"${busy || !info.hasFfmpeg ? ' disabled' : ''}>${busy ? 'Working...' : 'Make my montage'}</button></div>
    ${String(d.autoSource).startsWith('match:') ? '<div class="muted" style="font-size:14px"><b>Using your real kills from CS2</b> to pick the moments, then lining them up with your clips.</div>' : ''}
    <div class="muted" style="font-size:13px">${d.style !== 'clean' && d.detect === 'vision' ? 'AI vision sends small frames from your loudest clips to Anthropic (about a cent or two per clip) to spot kills and big plays.' : 'Sound only judges "exciting" by loudness, so it can\'t see what happened on screen.'} Styled montages take a few minutes to render. If it picks a clip you don't want, use "Pick clips myself" below.</div></div>` : '';
  const toggle = mont.clips.length ? `<div class="row"><div class="lbl grow">Prefer to choose the clips yourself?</div><button class="btn" data-act="m-manual">${d.manual ? 'Hide manual editor' : 'Pick clips myself'}</button></div>` : '';
  const manualBody = `${builder}
    ${mont.clips.length ? `<div class="row" style="flex-wrap:wrap"><select data-draft="montage.source" data-rerender="1" aria-label="Which clips to show"><option value="all"${d.source === 'all' ? ' selected' : ''}>All clips (${mont.clips.length}), newest first</option>${options}${unmatched && groups.size ? `<option value="none"${d.source === 'none' ? ' selected' : ''}>Not linked to a session (${unmatched})</option>` : ''}</select>
        <span class="muted grow">Clips are linked to the game session they were saved during.</span><button class="btn" data-act="m-all"${list.length ? '' : ' disabled'}>Select all shown</button></div>
      <div class="clips">${cards}</div>
      ${list.length > mont.shown ? '<div style="text-align:center"><button class="btn" data-act="m-more">Show more</button></div>' : ''}`
    : `<div class="card empty"><div class="big">No clips found</div><div class="muted" style="font-size:15px">There are no video files in ${esc(info.folder)}. If your clips are somewhere else, change the clips folder.</div></div>`}`;
  return `${head}
    <div class="muted path" style="margin-top:-10px" title="${esc(info.folder)}">Clips folder: ${esc(info.folder)}${info.detected ? ' (found automatically)' : ''}</div>
    ${info.hasFfmpeg ? '' : '<div class="card banner"><b class="t">The video tools are missing, so montages can\'t be made yet.</b><div class="muted">Run update.bat again with an internet connection. It downloads them once.</div></div>'}
        ${status}${autoCard}${toggle}${!mont.clips.length || d.manual ? manualBody : ''}`;
}


/* ---------- CS2 matches ---------- */
const cs2ui = { data: null, loading: false, sel: null, setup: null };
async function loadCs2() {
  cs2ui.loading = true;
  try { cs2ui.data = await window.api.cs2Data(); } finally { cs2ui.loading = false; }
  softRender();
}
const pc = (v) => (v == null ? '-' : v + '%');
const resWord = (r) => ({ win: 'Win', loss: 'Loss', tie: 'Draw' }[r] || 'Unfinished');
const resColor = (r) => ({ win: '#2DD4BF', loss: '#E5383B', tie: '#F5A524' }[r] || '#5A5A66');
const BUYS = { pistol: 'Pistol rounds', eco: 'Eco (saving)', force: 'Force buys', full: 'Full buys' };

function cs2Status() {
  const c = state.cs2 || {}, ui = cs2ui.setup;
  const recent = c.lastDataAt && Date.now() - c.lastDataAt < 30000;
  const mismatch = c.configured && c.cfgPort && c.port && c.cfgPort !== c.port;
  let body;
  if (!c.listening) body = `<b class="t">TrackerBean couldn't open its listening port.</b><div class="muted">Close other programs using ports 3737-3746 and restart TrackerBean.</div>`;
  else if (!c.configured || mismatch) body = `<div class="row" style="flex-wrap:wrap"><div class="grow"><div class="lbl">${mismatch ? 'Update needed' : 'One-time setup'}</div><div class="big" style="font-size:26px">${mismatch ? 'Update the CS2 connection' : 'Connect CS2 to TrackerBean'}</div>
      <div class="muted" style="font-size:15px;margin-top:4px">CS2 has an official feature that sends live match data to an app on your PC (kills, damage, rounds, money, weapons). This adds a small file to CS2's config folder to turn it on. It is safe for your account and never leaves your PC.</div></div>
      <button class="btn red" data-act="cs2-setup">${mismatch ? 'Update setup' : 'Set up CS2'}</button></div>`;
  else body = `<div class="row"><span class="dot" style="background:${recent ? '#2DD4BF' : '#5A5A66'}"></span><div class="grow"><b>${recent ? 'Receiving data from CS2' : 'Waiting for CS2'}</b>
      <div class="muted">${recent ? 'Matches are saved automatically when they end.' : 'Start a match (Competitive, Wingman or Casual). If CS2 was already open, restart it once.'}</div></div><button class="btn ghost" data-act="cs2-setup">Re-run setup</button></div>`;
  let result = '';
  if (ui) {
    if (ui.ok) result = `<div class="muted" style="margin-top:10px">Done. Saved to ${esc(ui.dir)}. <b>Restart CS2 if it's open</b>, then play a match.</div>`;
    else result = `<div class="muted" style="margin-top:10px">${esc(ui.error)}</div>${ui.manual ? `<div class="muted" style="margin-top:8px">File name: <b>${esc(ui.fileName)}</b></div><textarea readonly rows="12" style="margin-top:6px;font-family:Consolas,monospace;font-size:13px">${esc(ui.text)}</textarea>` : ''}`;
  }
  return `<div class="card">${body}${result}</div>`;
}

function renderCs2Detail(m) {
  const s = m.summary, d = new Date(m.startedAt);
  const rnd = m.rounds.map((r) => {
    const b = r.pistol ? 'pistol' : r.equip == null ? '' : r.equip < 1500 ? 'eco' : r.equip < 3700 ? 'force' : 'full';
    const tip = `Round ${r.n} · ${r.side || '?'} side · ${r.result || '?'} · ${r.kills} kill${r.kills === 1 ? '' : 's'} · ${r.dmg} damage${r.died ? ' · died' : ''}${b ? ' · ' + b + ' buy' : ''}${r.equip != null ? ' ($' + r.equip + ')' : ''}`;
    return `<div class="rnd ${r.result || ''} ${r.side === 'CT' ? 'ct' : 't'}" title="${esc(tip)}"><span>${r.n}</span><b>${r.kills || ''}</b><i>${r.dmg}</i>${r.died ? '<em>☠</em>' : ''}</div>`;
  }).join('');
  const side = (k, n) => { const x = s.sides[k]; return `<div class="card grow"><div class="lbl">${n} side</div><div class="big">${pc(x.winPct)}</div><div class="muted">${x.rounds} rounds · ${x.adr == null ? '-' : x.adr} ADR · ${x.kills}/${x.deaths}</div></div>`; };
  const ws = Object.entries(s.weapons).sort((a, b) => b[1].kills - a[1].kills).slice(0, 6);
  const buys = Object.entries(s.buys).filter(([, x]) => x.rounds).map(([k, x]) => `<div class="trow"><span>${BUYS[k]}</span><span>${x.rounds}</span><span>${pc(x.winPct)}</span><span>${x.adr == null ? '-' : x.adr}</span></div>`).join('');
  const ins = (m.insights || []).map((t) => `<li>${esc(t)}</li>`).join('');
  return `<div class="h"><div class="row"><button class="btn" data-act="cs2-back">← All matches</button><h1 style="margin-left:6px">${esc(m.map)}</h1></div>
      <div class="row"><button class="btn red" data-act="cs2-montage" data-id="${m.id}"${m.kills ? '' : ' disabled'}>Make highlight montage</button><button class="btn ghost" data-act="cs2-del" data-id="${m.id}">Delete</button></div></div>
    <div class="card row"><div class="big" style="color:${resColor(m.result)}">${resWord(m.result)} ${m.score.you}-${m.score.enemy}</div><div class="grow muted" style="font-size:15px">${esc(m.mode)} · ${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${fmt(m.endedAt - m.startedAt)}${m.complete ? '' : ' · left early'}</div></div>
    <div class="stats">
      <div class="card"><div class="lbl">K / D / A</div><div class="big">${s.kills}/${s.deaths}/${s.assists}</div></div>
      <div class="card"><div class="lbl">ADR</div><div class="big" style="color:#F5A524">${s.adr}</div></div>
      <div class="card"><div class="lbl">Headshots</div><div class="big" style="color:#A78BFA">${pc(s.hsPct)}</div></div>
      <div class="card"><div class="lbl">Survived</div><div class="big" style="color:#2DD4BF">${pc(s.survivalPct)}</div></div></div>
    ${ins ? `<div class="card"><div class="lbl">What stands out</div><ul class="ins">${ins}</ul></div>` : ''}
    <div class="card"><div class="lbl">Round by round</div><div class="rounds">${rnd}</div>
      <div class="legend" style="margin-top:10px"><span><i style="background:#2DD4BF"></i>Won</span><span><i style="background:#E5383B"></i>Lost</span><span>Top number = kills, bottom = damage, ☠ = died. Blue top = CT, amber top = T.</span></div></div>
    <div class="two">${side('CT', 'CT')}${side('T', 'T')}
      <div class="card grow"><div class="lbl">Multi-kills</div><div class="big">${s.multi[2]} · ${s.multi[3]} · ${s.multi[4]} · ${s.multi[5]}</div><div class="muted">2K · 3K · 4K · ace</div></div></div>
    <div class="two"><div class="card grow"><div class="lbl" style="padding-bottom:6px">Economy</div><div class="trow h"><span>Buy</span><span>Rounds</span><span>Won</span><span>ADR</span></div>${buys || '<div class="muted">No economy data.</div>'}</div>
      <div class="card grow"><div class="lbl" style="padding-bottom:6px">Weapons</div><div class="trow h"><span>Weapon</span><span>Kills</span><span>HS</span><span></span></div>${ws.map(([w, x]) => `<div class="trow"><span>${esc(w.toUpperCase())}</span><span>${x.kills}</span><span>${pc(x.kills ? Math.round((x.hs / x.kills) * 100) : null)}</span><span></span></div>`).join('') || '<div class="muted">No kills recorded.</div>'}</div></div>`;
}

function renderCs2() {
  const data = cs2ui.data, head = `<div class="h"><h1>CS2 Matches</h1><span class="sub">Match data from the game itself</span></div>`;
  const live = state.cs2 && state.cs2.live;
  const liveCard = live ? `<div class="card row hero"><div class="grow"><div class="lbl" style="color:#FF6B6E">● Match in progress</div><div class="big" style="font-size:30px">${esc(live.map)}</div><div class="muted" style="font-size:15px">${live.rounds} rounds played · CT ${live.scoreCT} - ${live.scoreT} T${live.side ? ' · you are ' + live.side : ''}</div></div></div>` : '';
  if (data && cs2ui.sel) { const m = data.matches.find((x) => x.id === cs2ui.sel); if (m) return renderCs2Detail(m); cs2ui.sel = null; }
  if (!data) return `${head}${cs2Status()}${liveCard}<div class="card empty"><div class="muted" style="font-size:15px">Loading...</div></div>`;
  const o = data.overview;
  if (!o) return `${head}${cs2Status()}${liveCard}<div class="card empty"><div class="big">No matches yet</div><div class="muted" style="font-size:15px">Once CS2 is connected, every match you play is saved here with round-by-round stats.</div></div>`;
  const s = o.summary, tr = o.trend, maxAdr = Math.max(...tr.map((t) => t.adr), 1);
  const bars = tr.map((t) => `<div class="bar" title="${esc(t.map)} · ${resWord(t.result)} · ${t.adr} ADR · ${t.kd} K/D" style="height:${Math.max(3, (t.adr / maxAdr) * 100)}%;background:${resColor(t.result)}"></div>`).join('');
  const maps = o.maps.map((x) => `<div class="trow"><span>${esc(x.map)}</span><span>${x.matches}</span><span>${pc(x.winPct)}</span><span>${x.adr}</span></div>`).join('');
  const buys = Object.entries(s.buys).filter(([, x]) => x.rounds).map(([k, x]) => `<div class="trow"><span>${BUYS[k]}</span><span>${x.rounds}</span><span>${pc(x.winPct)}</span><span>${x.adr == null ? '-' : x.adr}</span></div>`).join('');
  const ws = Object.entries(s.weapons).sort((a, b) => b[1].kills - a[1].kills).slice(0, 6).map(([w, x]) => `<div class="trow"><span>${esc(w.toUpperCase())}</span><span>${x.kills}</span><span>${pc(x.kills ? Math.round((x.hs / x.kills) * 100) : null)}</span><span></span></div>`).join('');
  const row = (n, x) => `<div class="trow"><span>${n}</span><span>${x.rounds}</span><span>${pc(x.winPct)}</span><span>${x.adr == null ? '-' : x.adr}</span></div>`;
  const ins = o.insights.map((t) => `<li>${esc(t)}</li>`).join('');
  const list = data.matches.map((m) => `<button class="card mrow" data-act="cs2-open" data-id="${m.id}"><span class="mres" style="background:${resColor(m.result)}"></span>
      <div class="grow" style="text-align:left"><b style="font-size:17px">${esc(m.map)}</b> <span class="muted">${esc(m.mode)}</span><div class="muted">${new Date(m.startedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${new Date(m.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div></div>
      <div style="text-align:right;min-width:70px"><b style="color:${resColor(m.result)}">${resWord(m.result)}</b><div class="muted">${m.score.you}-${m.score.enemy}</div></div>
      <div style="text-align:right;min-width:90px"><b>${m.summary.kills}/${m.summary.deaths}/${m.summary.assists}</b><div class="muted">K/D/A</div></div>
      <div style="text-align:right;min-width:60px"><b style="color:#F5A524">${m.summary.adr}</b><div class="muted">ADR</div></div></button>`).join('');
  return `${head}${cs2Status()}${liveCard}
    <div class="stats">
      <div class="card"><div class="lbl">Win rate</div><div class="big" style="color:#2DD4BF">${pc(o.winPct)}</div><div class="muted">${o.win}W ${o.loss}L ${o.tie}D · ${o.matches} matches</div></div>
      <div class="card"><div class="lbl">K / D</div><div class="big">${s.kd}</div><div class="muted">${s.kills} kills, ${s.deaths} deaths</div></div>
      <div class="card"><div class="lbl">ADR</div><div class="big" style="color:#F5A524">${s.adr}</div><div class="muted">damage per round</div></div>
      <div class="card"><div class="lbl">Headshots</div><div class="big" style="color:#A78BFA">${pc(s.hsPct)}</div><div class="muted">${pc(s.kasPct)} of rounds with impact</div></div></div>
    ${ins ? `<div class="card"><div class="lbl">What stands out</div><ul class="ins">${ins}</ul></div>` : ''}
    <div class="card"><div class="lbl">Last ${tr.length} matches (damage per round)</div><div class="chart" style="height:130px">${bars}</div><div class="legend" style="margin-top:8px"><span><i style="background:#2DD4BF"></i>Win</span><span><i style="background:#E5383B"></i>Loss</span></div></div>
    <div class="two"><div class="card grow"><div class="lbl" style="padding-bottom:6px">Maps</div><div class="trow h"><span>Map</span><span>Games</span><span>Won</span><span>ADR</span></div>${maps}</div>
      <div class="card grow"><div class="lbl" style="padding-bottom:6px">Sides and momentum</div><div class="trow h"><span></span><span>Rounds</span><span>Won</span><span>ADR</span></div>${row('CT side', s.sides.CT)}${row('T side', s.sides.T)}${row('After a win', s.afterWin)}${row('After a loss', s.afterLoss)}${row('First half', s.halves.first)}${row('Second half', s.halves.second)}</div></div>
    <div class="two"><div class="card grow"><div class="lbl" style="padding-bottom:6px">Economy</div><div class="trow h"><span>Buy</span><span>Rounds</span><span>Won</span><span>ADR</span></div>${buys}</div>
      <div class="card grow"><div class="lbl" style="padding-bottom:6px">Weapons</div><div class="trow h"><span>Weapon</span><span>Kills</span><span>HS</span><span></span></div>${ws}</div></div>
    <div class="lbl">Your matches</div>${list}`;
}


/* ---------- Steam profile + friends ---------- */
const sx = { data: null, loading: false, open: null, sort: 'week', local: [] };
const mins = (m) => fmt((m || 0) * 60000);
const steamHeader = (appid, name) => `<img class="cover" src="https://cdn.akamai.steamstatic.com/steam/apps/${+appid}/header.jpg" alt="" data-name="${esc(name)}" data-w="210" data-h="98" loading="lazy">`;
function avatarOf(e, cls = '') {
  if (e && e.avatar) return `<img class="avatar ${cls}" src="${esc(e.avatar)}" alt="">`;
  const name = (e && e.name) || '?', [bg, fg] = colorFor(name);
  return `<div class="avatar ph ${cls}" style="background:${bg};color:${fg}">${esc(initials(name))}</div>`;
}
async function loadSocial(force) {
  if (sx.loading) return;
  sx.loading = true; softRender();
  try { sx.data = await window.api.socialData(!!force); } catch { /* keep the old data */ }
  sx.loading = false; softRender();
}
const trackedMs = () => state.sessions.reduce((t, s) => t + Math.max(0, endOf(s) - s.start), 0);
function mergedTop(list) {
  const m = new Map();
  for (const e of list) for (const g of e.top || []) {
    const x = m.get(g.appid) || { appid: g.appid, name: g.name, mins: 0, mins2w: 0 };
    x.mins += g.mins; x.mins2w += g.mins2w; m.set(g.appid, x);
  }
  return [...m.values()].sort((a, b) => b.mins - a.mins);
}
const isPriv = (e) => !!(e.private || e.pending);
// Linked accounts with the main one first. Works before Steam data has loaded.
function orderedAccounts() {
  const p = state.profile, have = (sx.data && sx.data.accounts) || [];
  const list = p.accounts.map((a) => have.find((x) => x.steamId === a.steamId) || { steamId: a.steamId, name: 'Steam account', pending: true, top: [] });
  return [...list.filter((e) => e.steamId === p.main), ...list.filter((e) => e.steamId !== p.main)];
}
function accountBar() {
  const p = state.profile;
  if (!p.accounts.length) return `<div class="card row acctbar"><div class="grow"><div class="lbl">Steam profile</div><div class="muted" style="font-size:15px;margin-top:6px">Link your Steam account to show your profile here.</div></div><button class="btn red" data-act="nav" data-view="profile">Link Steam</button></div>`;
  const [main, ...alts] = orderedAccounts();
  const sub = main.pending ? (p.hasKey ? 'Loading...' : 'Add your Steam API key to load your name and photo') : `${statusDot(main)}${statusText(main)}`;
  const altBtns = alts.map((a) => `<button class="alt" data-act="sx-set-main" data-id="${a.steamId}" title="Switch to ${esc(a.name)}">${avatarOf(a, 'xs')}<span class="altn"><span class="muted">Alt</span><b>${esc(a.name)}</b></span><span class="swap">⇄</span></button>`).join('');
  return `<div class="card row acctbar">${avatarOf(main)}<div class="grow"><div class="lbl">Playing as <span class="chip">Main</span></div><div class="big" style="font-size:30px">${esc(main.name)}</div><div class="muted" style="font-size:15px">${sub}</div></div>${altBtns ? `<div class="alts">${altBtns}</div>` : ''}</div>`;
}
function friendsWidget() {
  const p = state.profile;
  if (!p.accounts.length && !p.friends.length) return `<div class="card row"><div class="grow"><div class="lbl">Friends</div><div class="muted" style="font-size:15px;margin-top:6px">Link your Steam account to see how your playtime compares with your friends.</div></div><button class="btn red" data-act="nav" data-view="profile">Link Steam</button></div>`;
  if (!p.hasKey) return `<div class="card row"><div class="grow"><div class="lbl">Friends</div><div class="muted" style="font-size:15px;margin-top:6px">Add your Steam API key to load playtime.</div></div><button class="btn amber" data-act="nav" data-view="profile">Open Profile</button></div>`;
  const sp = socialPeople();
  const all = rankPeople([...(sp.hasMe ? [sp.me] : []), ...sp.friends], 'twoWeeks');
  const shown = all.filter((e) => !isPriv(e)).slice(0, 5);
  const rows = shown.map((e, i) => `<div class="item"><span class="rank${i < 3 ? ' top' : ''}">${i + 1}</span>${avatarOf(e, 'sm')}<div class="grow"><b>${esc(e.name)}${e.me ? ' <span class="chip">You</span>' : appChip(e)}</b><div class="muted">${e.me ? meLabel() : `${statusDot(e)}${statusText(e)}`}</div></div><div class="fnum"><b style="color:#F5A524">${mins(e.twoWeeks)}</b><div class="muted">last 2 weeks</div></div></div>`).join('');
  const body = rows || `<div class="muted" style="padding:12px 0">${sx.loading || !sx.data ? 'Loading...' : p.friends.length ? 'No public playtime to show yet.' : 'No friends added yet.'}</div>`;
  return `<div class="card"><div class="row"><div class="grow"><div class="lbl">Friends · last 2 weeks</div></div>${p.friends.length ? '' : '<button class="btn ghost" data-act="nav" data-view="friends">Add friends</button>'}<button class="btn ghost" data-act="nav" data-view="friends">See all</button></div>${body}</div>`;
}
/* ---------- games you both own (Friends) + backlog helper (Challenge) ---------- */
const sh = { id: null, loading: false, res: null, all: false };
const bl = { loading: false, loaded: false, data: null };
function sharedHtml(e) {
  const btn = (label) => `<button class="btn" data-act="sx-shared" data-id="${e.steamId}">${label}</button>`;
  if (sh.id !== e.steamId) return `<div style="margin-top:14px">${btn('Games you both own')}</div>`;
  if (sh.loading) return '<div class="muted" style="margin-top:14px">Comparing your libraries...</div>';
  const r = sh.res;
  if (!r || !r.ok) return `<div class="muted" style="margin-top:14px">${esc((r && r.error) || 'Could not compare libraries.')}</div><div style="margin-top:8px">${btn('Try again')}</div>`;
  if (!r.total) return `<div class="muted" style="margin-top:14px">You don't own any of the same games (you have ${r.mineCount}, they have ${r.theirCount}).</div>`;
  const shown = sh.all ? r.list : r.list.slice(0, 12);
  const cards = shown.map((g) => `<div class="fgame">${steamHeader(g.appid, g.name)}<div><b>${esc(g.name)}</b><div class="muted"><span style="color:#F5A524">You ${mins(g.mine)}</span> · ${esc(e.name)} ${mins(g.theirs)}</div></div></div>`).join('');
  return `<div style="margin-top:14px"><div class="lbl">Games you both own</div><div class="muted" style="font-size:14px;margin:4px 0 8px">${r.total} in common, most played first. You own ${r.mineCount}, ${esc(e.name)} owns ${r.theirCount}.</div><div class="fgames">${cards}</div>${r.list.length > 12 ? `<div style="margin-top:10px"><button class="btn ghost" data-act="sx-shared-more">${sh.all ? 'Show fewer' : `Show all ${r.list.length}${r.total > r.list.length ? '+' : ''}`}</button></div>` : ''}</div>`;
}
async function loadBacklog(force) {
  if (bl.loading) return;
  bl.loading = true; softRender();
  try { bl.data = await window.api.socialBacklog(!!force); } catch { bl.data = { ok: false, error: "Couldn't load your Steam library." }; }
  bl.loading = false; bl.loaded = true; softRender();
}
function maybeLoadBacklog() {
  const p = state.profile;
  if (!bl.loaded && !bl.loading && p.accounts.length && p.hasKey) loadBacklog(false);
}
function backlogCard() {
  const p = state.profile, q = state.quest || {}, d = draft.quest;
  const title = '<div class="lbl">Backlog helper</div>';
  if (!p.accounts.length || !p.hasKey) return `<div class="card row"><div class="grow">${title}<div class="muted" style="font-size:15px;margin-top:6px">Link Steam and add your API key to find games you own but have never played.</div></div><button class="btn amber" data-act="nav" data-view="profile">Open Profile</button></div>`;
  if (bl.loading && !bl.data) return `<div class="card">${title}<div class="muted" style="margin-top:8px">Checking your Steam library...</div></div>`;
  const r = bl.data;
  if (!r || !r.ok) return `<div class="card">${title}<div class="muted" style="font-size:15px;margin:8px 0">${esc((r && r.error) || 'Not loaded yet.')}</div><button class="btn" data-act="bl-load">Try again</button></div>`;
  const idle = !q.current && !q.pending && !q.finished;
  const inst = r.list.filter((g) => g.gameId && gameById(g.gameId)), rest = r.list.filter((g) => !inst.includes(g));
  const head = `<div class="row" style="flex-wrap:wrap"><div class="grow">${title}<div class="muted" style="font-size:15px;margin-top:6px">${r.total} of your ${r.owned} Steam games have never been played${inst.length ? ` · ${inst.length} installed and ready for a challenge` : ''}.</div></div>
    <button class="btn" data-act="bl-load"${bl.loading ? ' disabled' : ''}>${bl.loading ? 'Refreshing...' : 'Refresh'}</button></div>`;
  const actions = inst.length ? `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:12px">${idle && inst.length ? `<button class="btn red" data-act="bl-random">Start with a random backlog game</button>` : ''}<button class="btn" data-act="bl-only" title="Leaves every game you've already played out of the challenge">Challenge only unplayed games</button><button class="btn ghost" data-act="bl-all">Include all games again</button></div>` : '';
  const tiles = inst.length ? `<div class="fgames" style="margin-top:14px">${inst.slice(0, 12).map((g) => `<div class="fgame">${steamHeader(g.appid, g.name)}<div><b>${esc(g.name)}</b><div class="muted">Installed · never played</div></div>${idle ? `<button class="btn" data-act="bl-start" data-id="${g.gameId}">Start challenge with this</button>` : ''}</div>`).join('')}</div>${inst.length > 12 ? `<div class="muted" style="margin-top:8px">+ ${inst.length - 12} more installed</div>` : ''}` : '';
  const list = rest.length ? `<div class="lbl" style="margin-top:16px">Not installed</div><div class="muted" style="font-size:14px;margin:4px 0 6px">Install one and rescan on the Games tab to add it to the challenge.</div>${rest.slice(0, 15).map((g) => `<div class="item"><div class="grow"><b>${esc(g.name)}</b></div><button class="btn ghost" data-act="sx-install" data-appid="${g.appid}">Install</button></div>`).join('')}${rest.length > 15 ? `<div class="muted" style="margin-top:8px">+ ${rest.length - 15} more</div>` : ''}` : '';
  if (!r.total) return `<div class="card">${head}<div class="muted" style="margin-top:10px">Nothing left in your backlog. You've played everything you own.</div></div>`;
  return `<div class="card">${head}${actions}${tiles}${list}</div>`;
}
const appChip = (e) => (e.hasApp ? ' <span class="chip ok" title="Also uses TrackerBean">TrackerBean</span>' : '');
const statusDot = (e) => `<span class="pdot${e.playing ? ' play' : e.status > 0 ? ' on' : ''}"></span>`;
const statusText = (e) => (e.playing ? `Playing ${esc(e.playing)}` : e.status > 0 ? 'Online' : 'Offline');
function sxBanner() {
  const d = sx.data;
  if (!state.profile.hasKey) return `<div class="card banner"><b class="t">Steam API key needed</b><div class="muted" style="font-size:15px">Playtime comes from Steam. Add your free API key on the Profile page to load hours.</div><div><button class="btn amber" data-act="nav" data-view="profile">Go to Profile</button></div></div>`;
  return d && d.error ? `<div class="card banner"><b class="t">${esc(d.error)}</b></div>` : '';
}

function renderProfile() {
  const p = state.profile, d = sx.data, accts = d ? d.accounts : [];
  const known = accts.filter((a) => !a.pending && !a.private);
  const steamTotal = known.reduce((t, a) => t + (a.total || 0), 0);
  const owned = known.reduce((t, a) => t + (a.count || 0), 0);
  const first = orderedAccounts()[0];
  const shown = p.name || (first && !first.pending && first.name) || 'Your profile';
  const top = mergedTop(known).slice(0, 8);
  const hero = `<div class="card row hero">${avatarOf(first)}<div class="grow"><div class="lbl">Your profile</div><div class="big" style="font-size:34px">${esc(shown)}</div>
      <div class="muted" style="font-size:15px">${p.accounts.length ? `${p.accounts.length} Steam account${p.accounts.length === 1 ? '' : 's'} linked` : 'No Steam account linked yet'}</div></div></div>`;
  const stats = `<div class="stat3">
      <div class="card"><div class="lbl">Tracked by TrackerBean</div><div class="big">${fmt(trackedMs())}</div></div>
      <div class="card"><div class="lbl">Steam lifetime</div><div class="big" style="color:#F5A524">${known.length ? mins(steamTotal) : '-'}</div></div>
      <div class="card"><div class="lbl">Steam games</div><div class="big" style="color:#2DD4BF">${known.length ? owned : '-'}</div></div></div>`;
  const nameCard = `<div class="card"><div class="lbl">Display name</div><div class="addrow" style="margin-top:10px"><input type="text" id="sx-name" value="${esc(p.name)}" placeholder="${esc((first && first.name) || 'Your name')}" maxlength="30"><button class="btn" data-act="sx-name">Save</button></div></div>`;
  const rows = orderedAccounts().map((a0) => {
    const a = { steamId: a0.steamId };
    const e = accts.find((x) => x.steamId === a.steamId) || { steamId: a.steamId, name: a.steamId, top: [] };
    return `<div class="item">${avatarOf(e, 'sm')}<div class="grow"><b>${esc(e.name)}</b><div class="muted">${e.pending ? (sx.loading ? 'Loading...' : 'Not loaded yet') : e.private ? 'Game details are private on Steam' : `${mins(e.total)} total · ${mins(e.twoWeeks)} last 2 weeks · ${e.count} games`}</div></div>${a.steamId === p.main ? '<span class="chip">Main</span>' : `<button class="btn" data-act="sx-set-main" data-id="${a.steamId}">Make main</button>`}<button class="btn ghost" data-act="sx-remove" data-kind="account" data-id="${a.steamId}">Unlink</button></div>`;
  }).join('') || '<div class="muted" style="padding:12px 0">No accounts linked. Sign in with Steam, or paste a profile link below. You can link more than one.</div>';
  const accountsCard = `<div class="card"><div class="row"><div class="grow"><div class="lbl">Steam accounts</div></div><button class="btn red" data-act="sx-login">Sign in with Steam</button></div>
      ${rows}
      <div class="addrow" style="margin-top:8px"><input type="text" data-draft="social.account" value="${esc(draft.social.account)}" placeholder="Or paste a steamcommunity.com profile link / ID"><button class="btn" data-act="sx-add" data-kind="account">Link account</button></div>
      <div class="muted" style="margin-top:10px">Sign in happens on Steam's own page. TrackerBean never sees your password. For your hours to show, set <b>Game details</b> to Public in Steam's privacy settings.</div></div>`;
  const found = (sx.local || []).filter((l) => !p.accounts.some((a) => a.steamId === l.steamId));
  const localCard = found.length ? `<div class="card"><div class="lbl" style="padding-bottom:6px">Found on this PC</div><div class="muted" style="font-size:15px">Accounts that have signed in to the Steam app here. Linking just reads the name, never a password.</div>${found.map((l) => `<div class="item">${avatarOf({ name: l.name }, 'sm')}<div class="grow"><b>${esc(l.name)}${l.recent ? ' <span class="chip">Signed in now</span>' : ''}</b><div class="muted">${esc(l.account)}</div></div><button class="btn red" data-act="sx-add-local" data-id="${l.steamId}">Link</button></div>`).join('')}${found.length > 1 ? '<div style="margin-top:8px"><button class="btn" data-act="sx-link-all">Link all</button></div>' : ''}</div>` : '';
  const keyCard = `<div class="card"><div class="lbl">Steam API key</div>
      <div class="muted" style="font-size:15px;margin:8px 0 10px">${p.hasKey ? 'Saved on this PC (encrypted when Windows allows it).' : 'A free key lets TrackerBean read playtime from Steam. Get one at steamcommunity.com/dev/apikey (type anything as the domain name) and paste it here.'}</div>
      <div class="addrow"><input type="password" id="sx-key" placeholder="${p.hasKey ? 'Paste a new key to replace it' : '32-character key'}" autocomplete="off" spellcheck="false"><button class="btn red" data-act="sx-key-save">Save key</button>${p.hasKey ? '<button class="btn ghost" data-act="sx-key-clear">Remove</button>' : ''}</div></div>`;
  const tog = (on, act, label) => `<button class="btn${on ? ' on' : ''}" data-act="${act}">${on ? '✓ ' : ''}${label}</button>`;
  const optsCard = `<div class="card"><div class="lbl">Accounts &amp; sharing</div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin:10px 0 6px">${p.accounts.length > 1 ? tog(p.combine, 'sx-combine', 'Count all my accounts together on Friends') : ''}${p.registry ? tog(p.share, 'sx-share', 'Let friends see I use TrackerBean') : ''}</div>
      <div class="muted" style="font-size:15px">${p.accounts.length > 1 ? 'Your <b>main</b> account is the one shown on Today and ranked on Friends. Click an alt on the Today tab to swap. ' : ''}${p.registry ? 'When sharing is on, TrackerBean tells a small lookup service your public Steam ID so friends who also use the app can see a TrackerBean badge next to your name. Nothing else is sent.' : ''}</div></div>`;
  const topCard = top.length ? `<div class="card"><div class="lbl" style="padding-bottom:6px">Most played on Steam</div>${top.map((g) => `<div class="item"><div class="grow"><b>${esc(g.name)}</b></div><b>${mins(g.mins)}</b></div>`).join('')}</div>` : '';
  return `<div class="h"><h1>Profile</h1><span class="sub">${sx.loading ? 'Loading Steam data...' : ''}</span></div>${sxBanner()}${hero}${stats}${localCard}${accountsCard}${keyCard}${nameCard}${optsCard}${topCard}`;
}

function socialPeople() {
  const p = state.profile, d = sx.data;
  const all = orderedAccounts();
  const accts = (p.combine ? all : all.slice(0, 1)).filter((a) => !a.pending && !a.private);
  const lead = all[0];
  const me = {
    me: true, steamId: 'me', name: p.name || (lead && !lead.pending && lead.name) || 'You',
    avatar: lead && lead.avatar, status: 1, playing: '',
    total: accts.reduce((t, a) => t + (a.total || 0), 0), twoWeeks: accts.reduce((t, a) => t + (a.twoWeeks || 0), 0),
    top: mergedTop(accts).slice(0, 12), private: !accts.length, pending: !d,
  };
  return { me, friends: d ? d.friends : [], hasMe: p.accounts.length > 0 };
}
const meLabel = () => (state.profile.combine && state.profile.accounts.length > 1 ? 'All linked accounts' : 'Main account');
const rankPeople = (list, key) => list.sort((a, b) => (isPriv(a) === isPriv(b) ? (b[key] || 0) - (a[key] || 0) : isPriv(a) ? 1 : -1));
function renderFriends() {
  const p = state.profile, d = sx.data;
  const key = sx.sort === 'week' ? 'twoWeeks' : 'total';
  const sp = socialPeople();
  const people = rankPeople([...(sp.hasMe ? [sp.me] : []), ...sp.friends], key);
  const sortChip = (v, label) => `<button class="btn${sx.sort === v ? ' on' : ''}" data-act="sx-sort" data-val="${v}">${label}</button>`;
  const list = people.map((e, i) => {
    const open = sx.open === e.steamId;
    const rank = isPriv(e) ? '' : i + 1;
    const body = open && !isPriv(e) ? `<div class="card" style="margin-top:-6px;border-top-left-radius:0;border-top-right-radius:0">${e.top.length ? `<div class="fgames">${e.top.slice(0, 8).map((g) => `<div class="fgame">${steamHeader(g.appid, g.name)}<div><b>${esc(g.name)}</b><div class="muted">${mins(g.mins)} total · ${mins(g.mins2w)} last 2 weeks</div></div></div>`).join('')}</div>` : '<div class="muted">No games with playtime yet.</div>'}${e.me ? '' : `${sharedHtml(e)}<div style="margin-top:12px;display:flex;gap:10px"><button class="btn ghost" data-act="sx-remove" data-kind="friend" data-id="${e.steamId}">Remove friend</button></div>`}</div>` : '';
    return `<button class="card frow${e.me ? ' me' : ''}" data-act="sx-open" data-id="${e.steamId}"${open && !isPriv(e) ? ' style="border-bottom-left-radius:0;border-bottom-right-radius:0"' : ''}>
      <span class="rank${rank && rank <= 3 ? ' top' : ''}">${rank || '-'}</span>${avatarOf(e, 'sm')}
      <div class="grow"><b style="font-size:17px">${esc(e.name)}${e.me ? ' <span class="chip">You</span>' : appChip(e)}</b><div class="muted">${e.pending && !e.me ? 'Loading...' : `${statusDot(e)}${e.me ? meLabel() : statusText(e)}`}</div></div>
      ${isPriv(e) ? `<div class="muted">${e.pending ? (sx.loading ? 'Loading...' : 'Not loaded') : e.me ? 'Your Steam game details are private' : 'Game details private'}</div>` : `<div class="fnum"><b style="color:${sx.sort === 'week' ? '#F5A524' : '#F2F2F3'}">${mins(e.twoWeeks)}</b><div class="muted">last 2 weeks</div></div><div class="fnum"><b style="color:${sx.sort === 'all' ? '#F5A524' : '#F2F2F3'}">${mins(e.total)}</b><div class="muted">all time</div></div>`}
    </button>${body}`;
  }).join('');
  const empty = !people.length ? `<div class="card empty"><div class="big">No friends yet</div><div class="muted" style="font-size:15px">Add a friend with their Steam profile link, or import your Steam friends list.${p.accounts.length ? '' : ' Link your own Steam account in Profile first.'}</div></div>` : '';
  const withApp = sp.friends.filter((f) => f.hasApp).length;
  const appNote = p.registry && sx.data && sx.data.registry ? (withApp ? `${withApp} of your friends ${withApp === 1 ? 'uses' : 'use'} TrackerBean` : 'None of your friends use TrackerBean yet') : 'Compare playtime';
  return `<div class="h"><h1>Friends</h1><span class="sub">${sx.loading ? 'Loading Steam data...' : appNote}</span></div>${sxBanner()}
    <div class="card"><div class="addrow"><input type="text" data-draft="social.friend" value="${esc(draft.social.friend)}" placeholder="Friend's Steam profile link or ID"><button class="btn red" data-act="sx-add" data-kind="friend">Add friend</button><button class="btn" data-act="sx-import">Import my Steam friends</button></div>
      <div class="muted" style="margin-top:10px">A friend's hours only show if their Steam <b>Game details</b> privacy is Public. They don't need TrackerBean.</div></div>
    <div class="row" style="flex-wrap:wrap"><span class="lbl">Rank by</span>${sortChip('week', 'Last 2 weeks')}${sortChip('all', 'All time')}<div class="grow"></div><button class="btn" data-act="sx-refresh"${sx.loading ? ' disabled' : ''}>Refresh</button></div>
    ${list}${empty}`;
}

/* ---------- extra actions ---------- */
async function extraActions(act, t) {
  const a = window.api;
  switch (act) {
    case 'draft-set': setDraft(t.dataset.path, t.dataset.val); render(); return true;
    case 'sx-login': {
      const r = await a.socialLogin();
      if (r && r.ok) { flash = 'Steam account linked.'; sx.data = null; loadSocial(true); }
      else if (r && r.error) { flash = r.error; render(); }
      return true;
    }
    case 'sx-add': {
      const kind = t.dataset.kind, field = kind === 'account' ? 'account' : 'friend';
      const r = await a.socialAdd(kind, draft.social[field]);
      if (r && r.ok) { draft.social[field] = ''; flash = kind === 'account' ? 'Steam account linked.' : 'Friend added.'; loadSocial(true); }
      else { flash = (r && r.error) || 'Something went wrong.'; render(); }
      return true;
    }
    case 'sx-remove': {
      if (!confirm(t.dataset.kind === 'account' ? 'Unlink this Steam account?' : 'Remove this friend?')) return true;
      await a.socialRemove(t.dataset.kind, t.dataset.id);
      if (sx.open === t.dataset.id) sx.open = null;
      loadSocial(false); return true;
    }
    case 'sx-import': {
      const r = await a.socialImportFriends();
      flash = r && r.ok ? (r.added ? `Added ${r.added} friend${r.added === 1 ? '' : 's'} from Steam.` : 'No new friends to add.') : ((r && r.error) || 'Something went wrong.');
      if (r && r.ok) loadSocial(true); else render();
      return true;
    }
    case 'sx-key-save': {
      const el = document.getElementById('sx-key');
      if (!el || !el.value.trim()) return true;
      const r = await a.socialSetKey(el.value);
      flash = r && r.ok ? 'Steam API key saved.' : ((r && r.error) || 'Could not save the key.');
      if (r && r.ok) { sx.data = null; loadSocial(true); } else render();
      return true;
    }
    case 'sx-key-clear': await a.socialSetKey(''); sx.data = null; flash = 'Steam API key removed.'; render(); return true;
    case 'sx-name': { const el = document.getElementById('sx-name'); await a.socialSetName(el ? el.value : ''); flash = 'Name saved.'; render(); return true; }
    case 'sx-add-local': { const r = await a.socialAdd('account', t.dataset.id); flash = r && r.ok ? 'Steam account linked.' : ((r && r.error) || 'Could not link it.'); sx.local = await a.socialLocal(); if (r && r.ok) loadSocial(true); else render(); return true; }
    case 'sx-link-all': { for (const l of sx.local || []) await a.socialAdd('account', l.steamId); sx.local = await a.socialLocal(); flash = 'Steam accounts linked.'; loadSocial(true); return true; }
    case 'sx-set-main': { await a.socialSetMain(t.dataset.id); flash = null; return true; }
    case 'sx-combine': await a.socialSetOpts({ combine: !state.profile.combine }); return true;
    case 'sx-share': await a.socialSetOpts({ share: !state.profile.share }); return true;
    case 'sx-sort': sx.sort = t.dataset.val; render(); return true;
    case 'sx-shared': { const id = t.dataset.id; sh.id = id; sh.loading = true; sh.res = null; sh.all = false; render(); const r = await a.socialShared(id); if (sh.id === id) { sh.res = r; sh.loading = false; render(); } return true; }
    case 'sx-shared-more': sh.all = !sh.all; render(); return true;
    case 'sx-install': await a.socialInstall(t.dataset.appid); return true;
    case 'bl-load': loadBacklog(true); return true;
    case 'bl-start': { const d = draft.quest; await a.questStart({ gameId: t.dataset.id, goalMin: Number(d.goalMin), mode: d.mode }); return true; }
    case 'bl-random': {
      const pool = ((bl.data && bl.data.list) || []).filter((g) => g.gameId && gameById(g.gameId));
      if (!pool.length) return true;
      const d = draft.quest, g = pool[Math.floor(Math.random() * pool.length)];
      await a.questStart({ gameId: g.gameId, goalMin: Number(d.goalMin), mode: d.mode }); return true;
    }
    case 'bl-only': { const ids = ((bl.data && bl.data.list) || []).map((g) => g.gameId).filter(Boolean); if (ids.length) await a.questOnly(ids); return true; }
    case 'bl-all': await a.questOnly(state.games.map((g) => g.id)); return true;
    case 'sx-open': sx.open = sx.open === t.dataset.id ? null : t.dataset.id; render(); return true;
    case 'sx-refresh': loadSocial(true); return true;
    case 'dismiss-flash': flash = null; render(); return true;
    case 'j-pick-img': { const n = await a.pickImages(); draft.journal.images = [...draft.journal.images, ...n].slice(0, 6); render(); return true; }
    case 'j-rm-img': draft.journal.images.splice(+t.dataset.i, 1); render(); return true;
    case 'j-save': {
      const d = draft.journal;
      if (!d.text.trim() && !d.images.length) { flash = 'Write something or add a screenshot first.'; render(); return true; }
      await a.addJournal({ gameId: d.gameId || null, mood: d.mood, text: d.text, left: d.left, images: d.images });
      draft.journal = { gameId: d.gameId, mood: 'good', text: '', left: false, images: [] };
      flash = null; render(); return true;
    }
    case 'j-del': if (confirm('Delete this journal entry?')) await a.deleteJournal(t.dataset.id); return true;
    case 'lightbox': draft.lightbox = t.dataset.src; render(); return true;
    case 'close-lightbox': draft.lightbox = null; render(); return true;
    case 'g-add': {
      const f = draft.goal;
      if (f.type === 'check' && !f.title.trim()) { flash = 'Describe your goal first.'; render(); return true; }
      if (f.type !== 'check' && !(Number(f.target) >= 1)) { flash = 'Enter a target of 1 or more.'; render(); return true; }
      await a.addGoal({ ...f, target: Number(f.target) });
      draft.goal.title = ''; flash = null; render(); return true;
    }
    case 'g-del': if (confirm('Delete this goal?')) await a.deleteGoal(t.dataset.id); return true;
    case 'g-check': { const g = (state.goals || []).find((x) => x.id === t.dataset.id); if (g) await a.updateGoal(g.id, { done: !g.done, doneAt: g.done ? null : Date.now() }); return true; }
    case 'bingo': await a.bingoToggle(+t.dataset.i); return true;
    case 'bingo-new': if (!state.bingo || !state.bingo.squares.some((s) => s.done) || confirm('Replace this card with a new one?')) await a.bingoNew(); return true;
    case 'cover-open': { const g = gameById(t.dataset.id); if (g) { coverModal = { gameId: g.id, results: [], busy: false, searched: false }; draft.coverTerm = g.name; render(); } return true; }
    case 'cover-close': coverModal = null; render(); return true;
    case 'cover-search': {
      if (!coverModal || !draft.coverTerm.trim()) return true;
      coverModal.busy = true; render();
      try { coverModal.results = await a.coverSearch(draft.coverTerm); } finally { if (coverModal) { coverModal.busy = false; coverModal.searched = true; } }
      render(); return true;
    }
    case 'cover-use': if (coverModal) { await a.coverSet(coverModal.gameId, t.dataset.key); coverModal = null; render(); } return true;
    case 'cover-file': if (coverModal && await a.coverPickFile(coverModal.gameId)) { coverModal = null; render(); } return true;
    case 'cover-reset': if (coverModal) { await a.coverReset(coverModal.gameId); coverModal = null; render(); } return true;
    case 'finish': await a.finishGame(t.dataset.id); return true;
    case 'q-start': { const d = draft.quest; await a.questStart({ gameId: d.gameId, goalMin: Number(d.goalMin), mode: d.mode }); return true; }
    case 'update-check': await a.updateCheck(); return true;
    case 'update-install': await a.updateInstall(); return true;
    case 'cs2-setup': cs2ui.setup = await a.cs2Setup(); render(); return true;
    case 'cs2-open': cs2ui.sel = t.dataset.id; render(); return true;
    case 'cs2-back': cs2ui.sel = null; render(); return true;
    case 'cs2-del': if (confirm('Delete this match from your history?')) { await a.cs2Delete(t.dataset.id); cs2ui.sel = null; await loadCs2(); } return true;
    case 'cs2-montage': draft.montage.autoSource = 'match:' + t.dataset.id; enterView('montage'); return true;
    case 'm-manual': draft.montage.manual = !draft.montage.manual; render(); if (draft.montage.manual) ensureMeta(); return true;
    case 'm-auto': {
      const d = draft.montage;
      if (mont.job && mont.job.busy) return true;
      const isMatch = String(d.autoSource).startsWith('match:');
      let ids = [];
      if (isMatch) ids = ['match'];
      else if (d.autoSource === 'recent') ids = mont.clips.slice(0, 20).map((c) => c.id);
      else if (/^(game|folder):/.test(String(d.autoSource))) ids = mont.clips.filter((c) => gameKeyForClip(c) === d.autoSource).slice(0, 150).map((c) => c.id).reverse();
      else ids = mont.clips.filter((c) => { const s = sessionForClip(c); return s && s.id === d.autoSource; }).sort((x, y) => x.mtime - y.mtime).map((c) => c.id);
      if (!ids.length) { flash = 'No clips found for that choice.'; render(); return true; }
      const sObj = state.sessions.find((x) => x.id === d.autoSource), g = sObj && gameById(sObj.gameId);
      const cm = isMatch && ((cs2ui.data && cs2ui.data.matches) || []).find((x) => 'match:' + x.id === d.autoSource);
      mont.job = { busy: true, pct: 0, stage: 'analyze' }; render();
      try {
        const r = await a.montageAuto({ ids, matchId: isMatch ? d.autoSource.slice(6) : undefined, target: d.autoLen === 'song' ? 'song' : Number(d.autoLen), clipVol: d.autoVol, music: !!d.musicName, style: d.style, fx: { ...d.fx }, format: d.format, framing: d.framing, detect: d.detect, caption: d.caption, name: cm ? `CS2 ${cm.map} highlights` : `${g ? g.name + ' ' : ''}Montage` });
        mont.job = { busy: false, ...r };
      } catch (e) { mont.job = { busy: false, ok: false, error: 'Something went wrong while making the montage.' }; }
      render(); return true;
    }
    case 'm-key-save': { const el = document.getElementById('m-key'); if (el && el.value.trim()) { await a.montageSetKey(el.value); mont.info = await a.montageInfo(); } render(); return true; }
    case 'm-key-clear': await a.montageSetKey(''); mont.info = await a.montageInfo(); render(); return true;
    case 'm-folder': { const f = await a.montagePickFolder(); if (f) { mont.loaded = false; mont.meta = {}; draft.montage.selected = []; await loadMontage(); } return true; }
    case 'm-rescan': mont.loaded = false; mont.meta = {}; await loadMontage(); return true;
    case 'm-toggle': { const sel = draft.montage.selected, i = sel.indexOf(t.dataset.id); if (i >= 0) sel.splice(i, 1); else if (sel.length < 40) sel.push(t.dataset.id); render(); return true; }
    case 'm-up': case 'm-down': { const sel = draft.montage.selected, i = +t.dataset.i, j = act === 'm-up' ? i - 1 : i + 1; if (sel[j] !== undefined) [sel[i], sel[j]] = [sel[j], sel[i]]; render(); return true; }
    case 'm-rm': draft.montage.selected.splice(+t.dataset.i, 1); render(); return true;
    case 'm-clear': draft.montage.selected = []; render(); return true;
    case 'm-sort': draft.montage.selected.sort((x, y) => ((clipById(x) || {}).mtime || 0) - ((clipById(y) || {}).mtime || 0)); render(); return true;
    case 'm-all': {
      const sel = draft.montage.selected;
      for (const c of montageView().list.slice(0, mont.shown)) { const m = mont.meta[c.id]; if (sel.length < 40 && !sel.includes(c.id) && !(m && !m.duration)) sel.push(c.id); }
      render(); return true;
    }
    case 'm-more': mont.shown += 24; render(); ensureMeta(); return true;
    case 'm-music': { const n = await a.montagePickMusic(); if (n) draft.montage.musicName = n; render(); return true; }
    case 'm-music-clear': await a.montagePickMusic('clear'); draft.montage.musicName = ''; render(); return true;
    case 'm-output': { if (await a.montagePickOutput()) { mont.info = await a.montageInfo(); render(); } return true; }
    case 'm-make': {
      const d = draft.montage;
      if (!d.selected.length || (mont.job && mont.job.busy)) return true;
      mont.job = { busy: true, pct: 0 }; render();
      try {
        const r = await a.montageMake({ ids: d.selected, transition: d.transition, res: d.res, fps: d.fps, trimLast: d.trimLast, clipVol: d.clipVol, musicVol: d.musicVol, music: !!d.musicName, name: d.name });
        mont.job = { busy: false, ...r };
      } catch (e) { mont.job = { busy: false, ok: false, error: 'Something went wrong while making the montage.' }; }
      render(); return true;
    }
    case 'm-cancel': await a.montageCancel(); return true;
    case 'm-open': await a.montageReveal('open'); return true;
    case 'm-show': await a.montageReveal('folder'); return true;
    case 'm-dismiss': mont.job = null; render(); return true;
    case 'q-exclude': await a.questExclude(t.dataset.id, !t.checked); return true;
    case 'q-choose': await a.questChoose(t.dataset.id); return true;
    case 'q-reroll': await a.questReroll(); return true;
    case 'q-reset': if (confirm('End the current challenge and clear its progress?')) await a.questReset(); return true;
    default: return false;
  }
}

/* ---------- plumbing ---------- */
function render() {
  const el = $('#view'), scroll = el.scrollTop;
  const views = { today: renderToday, games: renderGames, storage: renderStorage, stats: renderStats, journal: renderJournal, goals: renderGoals, quest: renderQuest, montage: renderMontage, cs2: renderCs2, profile: renderProfile, friends: renderFriends, settings: renderSettings };
  const fl = flash ? `<div class="card banner"><div class="row"><div class="grow"><b class="t">${esc(flash)}</b></div><button class="btn" data-act="dismiss-flash">Dismiss</button></div></div>` : '';
  el.innerHTML = fl + (views[view] || renderToday)();
  el.scrollTop = scroll;
  const ub = $('#updbox'), u = state.update || {};
  if (ub) ub.innerHTML = u.status === 'ready'
    ? `<div style="padding:0 6px 8px"><button class="btn red" data-act="update-install" style="width:100%">Update ready · restart</button><div class="muted" style="margin-top:4px;text-align:center">Version ${esc(u.version || '')}</div></div>`
    : u.status === 'downloading' ? `<div class="muted" style="padding:0 12px 8px">Downloading update ${u.percent || 0}%</div>` : '';
  document.querySelectorAll('.nav[data-view]').forEach((n) => n.classList.toggle('on', n.dataset.view === view));
}
async function loadDrives() { drives = await window.api.getDrives(); render(); }
function maybeMeasure() {
  const stale = state.games.some((g) => g.sizeAt == null || Date.now() - g.sizeAt > 864e5);
  if (!state.sizing && stale) window.api.refreshStorage();
}
function maybeLoadSocial() {
  const p = state.profile;
  if (!sx.loading && (p.accounts.length || p.friends.length) && (view !== 'today' || p.hasKey)) loadSocial(false);
}
function enterView(v) {
  view = v; flash = null; render();
  if (v === 'storage') { loadDrives(); maybeMeasure(); }
  if (v === 'goals' && !state.bingo) window.api.bingoNew();
  if (v === 'montage' && !mont.loaded && !mont.loading) loadMontage();
  if (v === 'cs2') { cs2ui.sel = null; loadCs2(); }
  if (v === 'quest') maybeLoadBacklog();
  if (v === 'profile') window.api.socialLocal().then((l) => { sx.local = l; softRender(); });
  if (['profile', 'friends', 'today'].includes(v)) maybeLoadSocial();
}
async function refresh() {
  const was = state.sizing;
  state = await window.api.getState();
  syncGoals();
  if (view === 'today' && !sx.data) maybeLoadSocial();
  softRender();
  if (view === 'cs2' && !cs2ui.loading) loadCs2();
  if (view === 'storage' && was && !state.sizing) loadDrives();
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act;
  if (await extraActions(act, t)) return;
  if (act === 'nav') enterView(t.dataset.view);
  else if (act === 'scan') { scanning = true; notice = null; render(); try { const r = await window.api.scan(); found = r.list; checked = r.checked; } finally { scanning = false; } render(); }
  else if (act === 'dismiss') { found = null; render(); }
  else if (act === 'pick') { notice = null; await window.api.pickGame(); render(); }
  else if (act === 'pick-folder') { const r = await window.api.pickFolder(); notice = r && r.error ? r.error : null; render(); }
  else if (act === 'dismiss-notice') { notice = null; render(); }
  else if (act === 'add-scan-folder') { await window.api.addScanFolder(); }
  else if (act === 'remove-scan-folder') { await window.api.removeScanFolder(+t.dataset.i); }
  else if (act === 'add-found') { const g = found[+t.dataset.i]; found = found.filter((x) => x !== g); await window.api.addGame(g); }
  else if (act === 'add-all') { const all = found; found = null; for (const g of all) await window.api.addGame(g); }
  else if (act === 'sort') { sortMode = t.dataset.mode; render(); }
  else if (act === 'refresh-sizes') { window.api.refreshStorage(); }
  else if (act === 'open-folder') { window.api.openFolder(t.dataset.id); }
  else if (act === 'uninstall') {
    const g = gameById(t.dataset.id);
    if (g && confirm(`Open Steam's uninstall prompt for ${g.name}? Steam will ask you to confirm.`)) window.api.uninstall(g.id);
  }
  else if (act === 'remove') {
    const g = gameById(t.dataset.id);
    if (g && confirm(`Remove ${g.name} and its play history?`)) await window.api.removeGame(g.id);
  }
});
document.addEventListener('change', async (e) => {
  const t = e.target.closest('[data-act="setting"]'); if (!t) return;
  await window.api.setSettings({ [t.dataset.key]: t.checked });
});

document.addEventListener('error', (e) => {
  const t = e.target;
  if (t.tagName === 'IMG' && t.dataset.name) {
    const target = t.dataset.icon && t.parentElement ? t.parentElement : t;
    target.outerHTML = cover(t.dataset.name, +t.dataset.w, +t.dataset.h);
  }
}, true);

window.api.onChange(refresh);
window.api.onMontageProgress((p) => {
  if (!mont.job || !mont.job.busy) return;
  const pct = typeof p === 'number' ? p : p.pct, stage = typeof p === 'object' ? p.stage : 'render';
  const changed = mont.job.stage !== stage;
  mont.job.pct = pct; mont.job.stage = stage;
  if (changed) { softRender(); return; }
  const bar = $('#mprog'), txt = $('#mpct');
  if (bar) bar.style.width = (pct * 100) + '%';
  if (txt) txt.textContent = Math.round(pct * 100) + '%';
});
setInterval(() => { const el = $('#timer'); if (el) el.textContent = clock(Date.now() - +el.dataset.start); }, 1000);
// Don't redraw while you're typing in a form (it would steal focus).
let pendingRender = false;
const editing = () => { const a = document.activeElement; return !!a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName); };
function softRender() { if (editing()) pendingRender = true; else render(); }
document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender && !editing()) { pendingRender = false; render(); } }, 600));
function onDraftInput(e) {
  const t = e.target;
  if (!t.dataset || !t.dataset.draft) return;
  setDraft(t.dataset.draft, t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value);
  if (e.type === 'change' && t.dataset.rerender) render();
  if (e.type === 'change' && t.dataset.draft === 'montage.source') { mont.shown = 24; ensureMeta(); }
}
document.addEventListener('input', onDraftInput);
document.addEventListener('change', onDraftInput);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && draft.lightbox) { draft.lightbox = null; render(); }
  else if (e.key === 'Escape' && coverModal) { coverModal = null; render(); }
  else if (e.key === 'Enter' && e.target.dataset && e.target.dataset.draft === 'coverTerm') { e.preventDefault(); extraActions('cover-search', e.target); }
});
setInterval(() => { syncGoals(); softRender(); }, 30000); // keep totals and progress moving during a session
refresh();
