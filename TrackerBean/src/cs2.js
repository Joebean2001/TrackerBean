// CS2 match data via Valve's official Game State Integration (GSI).
// CS2 POSTs JSON to a tiny local server whenever something changes. We turn that stream into matches:
// rounds, kills (with timestamps and weapons), damage, economy, sides, results.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IDLE_MS = 4 * 60 * 1000;      // no data for this long = the match is over (or CS2 was closed)
const MIN_ROUNDS = 5;               // shorter matches are discarded
const PRIMARY = new Set(['Rifle', 'SniperRifle', 'Machine Gun', 'SubmachineGun', 'Shotgun']);

/* ---------------- config for CS2 ---------------- */
function buildGsiConfig({ port, token }) {
  return `"TrackerBean"
{
  "uri"        "http://127.0.0.1:${port}"
  "timeout"    "5.0"
  "buffer"     "0.1"
  "throttle"   "0.1"
  "heartbeat"  "10.0"
  "auth"
  {
    "token"    "${token}"
  }
  "data"
  {
    "provider"            "1"
    "map"                 "1"
    "round"               "1"
    "player_id"           "1"
    "player_state"        "1"
    "player_weapons"      "1"
    "player_match_stats"  "1"
  }
}
`;
}
const CFG_NAME = 'gamestate_integration_trackerbean.cfg';

/* ---------------- recorder: payload stream -> matches ---------------- */
const activeWeapon = (weapons) => {
  for (const w of Object.values(weapons || {})) if (w && w.state === 'active') return String(w.name || '').replace(/^weapon_/, '');
  return null;
};
const primaryOf = (weapons) => {
  for (const w of Object.values(weapons || {})) if (w && PRIMARY.has(w.type)) return String(w.name || '').replace(/^weapon_/, '');
  return null;
};

class Recorder {
  constructor({ onFinished = () => {}, onUpdate = () => {} } = {}) {
    this.onFinished = onFinished; this.onUpdate = onUpdate;
    this.m = null; this.r = null; this.prevRound = null; this.last = null; this.lastSeen = 0; this.lastFinished = null;
  }
  get live() {
    if (!this.m) return null;
    return { map: this.m.map, mode: this.m.mode, rounds: this.m.rounds.length, scoreCT: this.m.scoreCT, scoreT: this.m.scoreT, side: this.m.team };
  }

  start(p, now) {
    this.m = { id: crypto.randomUUID(), startedAt: now, endedAt: null, map: p.map.name, mode: p.map.mode || 'unknown', steamid: String(p.provider.steamid || ''),
      team: null, scoreCT: 0, scoreT: 0, rounds: [], kills: [], deaths: [], complete: false, result: null, mapRound: p.map.round };
    this.r = null; this.prevRound = null; this.last = null;
  }

  finish(now, complete) {
    const m = this.m;
    if (!m) return;
    this.m = null; this.r = null;
    if (m.rounds.length < MIN_ROUNDS) return;
    m.endedAt = now; m.complete = complete;
    const mine = m.team === 'CT' ? m.scoreCT : m.scoreT, theirs = m.team === 'CT' ? m.scoreT : m.scoreCT;
    m.score = { you: mine, enemy: theirs };
    m.result = !complete ? 'unknown' : mine > theirs ? 'win' : mine < theirs ? 'loss' : 'tie';
    m.summary = summarize(m);
    this.lastFinished = m;
    this.onFinished(m);
  }

  // Call regularly: closes a match when the data stops coming.
  idleCheck(now) { if (this.m && now - this.lastSeen > IDLE_MS) this.finish(this.lastSeen, false); }

  handle(p, now = Date.now()) {
    if (!p || !p.provider || !p.map || !p.map.name) return;
    this.lastSeen = now;
    const map = p.map, ph = map.phase, mode = map.mode || '';
    if (mode === 'deathmatch' || mode === 'training' || !p.round) return; // no rounds to record

    // a new match? (different map, round counter went backwards, or warmup after we had live rounds)
    if (this.m && (this.m.map !== map.name || (Number.isFinite(map.round) && Number.isFinite(this.m.mapRound) && map.round < this.m.mapRound) || (ph === 'warmup' && this.m.rounds.length))) this.finish(now, false);
    if (!this.m) {
      if (ph === 'warmup' || ph === 'intermission' || !p.round.phase) return;
      this.start(p, now);
    }
    const m = this.m;
    m.scoreCT = (map.team_ct && map.team_ct.score) || 0;
    m.scoreT = (map.team_t && map.team_t.score) || 0;
    if (Number.isFinite(map.round)) m.mapRound = map.round;

    const pl = p.player, own = pl && String(pl.steamid) === m.steamid;
    const rp = p.round.phase;

    if (!this.r && (rp === 'freezetime' || rp === 'live')) this.r = { n: m.rounds.length + 1, startAt: now, kills: 0, hs: 0, dmg: 0, assists: 0, died: false, side: null, equip: null, money: null, weapon: null };
    const r = this.r;

    if (own) {
      m.team = pl.team || m.team;
      const st = pl.state || {}, ms = pl.match_stats || {};
      if (r) {
        if (!r.side) r.side = pl.team || null;
        r.kills = Math.max(r.kills, st.round_kills || 0);
        r.hs = Math.max(r.hs, st.round_killhs || 0);
        r.dmg = Math.max(r.dmg, st.round_totaldmg || 0);
        if (st.health === 0) r.died = true;
        if (rp === 'live' && r.equip === null && Number.isFinite(st.equip_value)) { r.equip = st.equip_value; r.money = st.money; r.weapon = primaryOf(pl.weapons); }
      }
      if (this.last && ms) {
        const dk = (ms.kills || 0) - this.last.kills, dd = (ms.deaths || 0) - this.last.deaths, da = (ms.assists || 0) - this.last.assists;
        const hsUp = (st.round_killhs || 0) > this.last.hs;
        for (let i = 0; i < dk && dk < 6; i++) m.kills.push({ at: now, round: m.rounds.length + 1, nth: Math.max(1, (st.round_kills || 0) - dk + i + 1), weapon: activeWeapon(pl.weapons), hs: hsUp && i === dk - 1 });
        if (dd > 0 && dd < 3) { m.deaths.push({ at: now, round: m.rounds.length + 1 }); if (r) r.died = true; }
        if (da > 0 && da < 6 && r) r.assists += da;
      }
      if (ms) this.last = { kills: ms.kills || 0, deaths: ms.deaths || 0, assists: ms.assists || 0, hs: st.round_killhs || 0 };
    }

    // round over -> save the round
    if (rp === 'over' && this.prevRound !== 'over' && r && r.startAt) {
      const done = m.rounds.length + 1, half = m.mode === 'wingman' ? 8 : 12;
      const prev = m.rounds[m.rounds.length - 1];
      m.rounds.push({
        n: done, side: r.side || m.team, result: r.side && p.round.win_team ? (r.side === p.round.win_team ? 'win' : 'loss') : null,
        kills: r.kills, hs: r.hs, dmg: r.dmg, assists: r.assists, died: r.died, equip: r.equip, money: r.money, weapon: r.weapon,
        half: done <= half ? 1 : 2, pistol: done === 1 || done === half + 1, prevResult: prev ? prev.result : null, startAt: r.startAt, endAt: now,
      });
      this.r = null;
      this.onUpdate();
    }
    this.prevRound = rp;
    if (ph === 'gameover') this.finish(now, true);
  }
}

/* ---------------- stats ---------------- */
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const buyOf = (r) => (r.pistol ? 'pistol' : r.equip == null ? 'unknown' : r.equip < 1500 ? 'eco' : r.equip < 3700 ? 'force' : 'full');

function summarize(m) {
  const R = m.rounds, kills = m.kills || [];
  const sum = (f) => R.reduce((t, r) => t + f(r), 0);
  const tot = { rounds: R.length, kills: sum((r) => r.kills), deaths: sum((r) => (r.died ? 1 : 0)), assists: sum((r) => r.assists), dmg: sum((r) => r.dmg), hs: sum((r) => r.hs) };
  const bucket = (rs) => {
    const k = rs.reduce((t, r) => t + r.kills, 0), d = rs.reduce((t, r) => t + (r.died ? 1 : 0), 0), dm = rs.reduce((t, r) => t + r.dmg, 0), w = rs.filter((r) => r.result === 'win').length;
    return { rounds: rs.length, wins: w, winPct: pct(w, rs.filter((r) => r.result).length), kills: k, deaths: d, adr: rs.length ? Math.round(dm / rs.length) : null, kd: d ? Math.round((k / d) * 100) / 100 : k };
  };
  const by = (f) => R.filter(f);
  const buys = {};
  for (const b of ['pistol', 'eco', 'force', 'full']) buys[b] = bucket(by((r) => buyOf(r) === b));
  const weapons = {};
  for (const k of kills) { const w = k.weapon || 'unknown'; weapons[w] = weapons[w] || { kills: 0, hs: 0 }; weapons[w].kills++; if (k.hs) weapons[w].hs++; }
  return {
    ...tot, adr: R.length ? Math.round(tot.dmg / R.length) : 0, kd: tot.deaths ? Math.round((tot.kills / tot.deaths) * 100) / 100 : tot.kills,
    hsPct: pct(tot.hs, tot.kills), survivalPct: pct(R.filter((r) => !r.died).length, R.length),
    kasPct: pct(R.filter((r) => r.kills > 0 || r.assists > 0 || !r.died).length, R.length),
    multi: { 2: by((r) => r.kills === 2).length, 3: by((r) => r.kills === 3).length, 4: by((r) => r.kills === 4).length, 5: by((r) => r.kills >= 5).length },
    sides: { CT: bucket(by((r) => r.side === 'CT')), T: bucket(by((r) => r.side === 'T')) },
    halves: { first: bucket(by((r) => r.half === 1)), second: bucket(by((r) => r.half === 2)) },
    afterLoss: bucket(by((r) => r.prevResult === 'loss')), afterWin: bucket(by((r) => r.prevResult === 'win')),
    buys, weapons,
  };
}

// Stats across many matches (rounds and kills are simply pooled).
function overview(matches) {
  const done = matches.filter((m) => m.rounds && m.rounds.length);
  if (!done.length) return null;
  const pooled = { rounds: done.flatMap((m) => m.rounds), kills: done.flatMap((m) => m.kills || []) };
  const s = summarize(pooled);
  const results = { win: 0, loss: 0, tie: 0 };
  for (const m of done) if (results[m.result] !== undefined) results[m.result]++;
  const maps = {};
  for (const m of done) {
    const x = maps[m.map] = maps[m.map] || { map: m.map, matches: 0, wins: 0, decided: 0, dmg: 0, rounds: 0 };
    x.matches++; if (m.result === 'win') x.wins++; if (m.result === 'win' || m.result === 'loss') x.decided++;
    x.dmg += m.summary.dmg; x.rounds += m.summary.rounds;
  }
  const mapList = Object.values(maps).map((x) => ({ map: x.map, matches: x.matches, winPct: pct(x.wins, x.decided), adr: Math.round(x.dmg / x.rounds) })).sort((a, b) => b.matches - a.matches);
  const trend = done.slice().sort((a, b) => a.startedAt - b.startedAt).slice(-20).map((m) => ({ id: m.id, adr: m.summary.adr, kd: m.summary.kd, result: m.result, map: m.map }));
  const decided = results.win + results.loss;
  const o = { matches: done.length, ...results, winPct: pct(results.win, decided), summary: s, maps: mapList, trend };
  o.insights = insights(s, { minRounds: 40, matches: done.length, maps: mapList });
  return o;
}

// Plain-English findings. `minRounds` keeps small samples from producing noise.
function insights(s, { minRounds = 40, matches = 1, maps = [] } = {}) {
  const out = [], f = (n) => (n == null ? '-' : n);
  const side = (a, b, na, nb) => {
    if (a.rounds >= minRounds / 2 && b.rounds >= minRounds / 2 && a.adr != null && Math.abs(a.adr - b.adr) >= 15)
      out.push(`Your damage is much better on ${a.adr > b.adr ? na : nb} side (${Math.max(a.adr, b.adr)} ADR) than ${a.adr > b.adr ? nb : na} side (${Math.min(a.adr, b.adr)} ADR). ${a.adr > b.adr ? nb : na} side is where to improve.`);
  };
  side(s.sides.CT, s.sides.T, 'CT', 'T');
  const need = Math.max(8, minRounds / 4);
  const b = s.buys;
  if (b.full.rounds >= need && b.force.rounds >= need && b.force.winPct != null && b.full.winPct != null && b.force.winPct <= b.full.winPct - 20)
    out.push(`Force-buys are costing you rounds: you win ${f(b.force.winPct)}% of them versus ${f(b.full.winPct)}% on full buys.`);
  if (b.eco.rounds >= need && b.eco.winPct != null) out.push(`On eco rounds you win ${f(b.eco.winPct)}% of the time${b.eco.adr != null ? ` and still average ${b.eco.adr} damage` : ''}.`);
  const L = s.afterLoss, W = s.afterWin;
  if (L.rounds >= minRounds / 2 && W.rounds >= minRounds / 2 && L.adr != null && W.adr - L.adr >= 10)
    out.push(`Your damage drops after you lose a round (${L.adr} ADR versus ${W.adr} after a win). Staying calm after a loss would help.`);
  else if (L.rounds >= minRounds / 2 && W.rounds >= minRounds / 2 && L.adr != null && L.adr - W.adr >= 10)
    out.push(`You play better after losing a round (${L.adr} ADR versus ${W.adr} after a win), so you bounce back well.`);
  const h1 = s.halves.first, h2 = s.halves.second;
  if (h1.rounds >= minRounds / 2 && h2.rounds >= minRounds / 2 && h1.adr != null && Math.abs(h1.adr - h2.adr) >= 12)
    out.push(h1.adr > h2.adr ? `You fade in the second half (${h1.adr} ADR first half, ${h2.adr} second half).` : `You warm up as the game goes on (${h1.adr} ADR first half, ${h2.adr} second half).`);
  const pist = b.pistol; if (pist.rounds >= 4 && pist.winPct != null) out.push(`You win ${f(pist.winPct)}% of pistol rounds.`);
  const ws = Object.entries(s.weapons).filter(([w, x]) => x.kills >= 8 && w !== 'unknown' && w !== 'knife').sort((x, y) => y[1].kills - x[1].kills);
  if (ws.length) out.push(`Your most-used weapon is the ${ws[0][0].toUpperCase()}: ${ws[0][1].kills} kills, ${f(pct(ws[0][1].hs, ws[0][1].kills))}% headshots.`);
  if (s.multi[5] || s.multi[4]) out.push(`You've had ${s.multi[5]} ace${s.multi[5] === 1 ? '' : 's'} and ${s.multi[4]} four-kill round${s.multi[4] === 1 ? '' : 's'}.`);
  const big = maps.filter((m) => m.matches >= 3 && m.winPct != null).sort((x, y) => y.winPct - x.winPct);
  if (matches >= 6 && big.length >= 2) out.push(`Best map: ${big[0].map} (${big[0].winPct}% wins). Weakest: ${big[big.length - 1].map} (${big[big.length - 1].winPct}%).`);
  if (s.survivalPct != null && s.rounds >= minRounds / 2) out.push(`You survive ${s.survivalPct}% of rounds and contribute (a kill, assist or survival) in ${f(s.kasPct)}% of them.`);
  return out;
}

/* ---------------- matching kills to recorded clips ---------------- */
const levelAt = (levels, rate, t, span = 0.2) => {
  let best = -90;
  for (let i = Math.max(0, Math.floor((t - span) * rate)); i <= Math.min(levels.length - 1, Math.floor((t + span) * rate)); i++) best = Math.max(best, levels[i]);
  return best;
};

// A clip file's time is when it was saved, which is a little after the moment it shows. We don't know how
// long after, so try delays from 0 to 15s and keep the one where the kills line up with loud sounds.
function momentsForClip(kills, clip) {
  const dur = clip.duration, rate = clip.rate || 10, lv = clip.levels || [];
  const lo = clip.mtime - dur * 1000 - 15000, hi = clip.mtime + 3000;
  const inRange = kills.filter((k) => k.at >= lo && k.at <= hi);
  if (!inRange.length) return [];
  let best = { delay: 2, score: -Infinity };
  if (lv.length) {
    for (let d = 0; d <= 15; d += 0.1) {
      const start = clip.mtime - dur * 1000 - d * 1000;
      let sc = 0;
      for (const k of inRange) { const t = (k.at - start) / 1000; if (t >= 0.2 && t <= dur - 0.1) sc += Math.pow(10, levelAt(lv, rate, t) / 10); }
      if (sc > best.score) best = { delay: d, score: sc };
    }
  }
  const start = clip.mtime - dur * 1000 - best.delay * 1000;
  const pos = inRange.map((k) => {
    let t = (k.at - start) / 1000;
    if (lv.length) { // snap to the loudest tenth of a second nearby: that's the gunshot
      let bi = -1, bv = -Infinity;
      for (let i = Math.max(0, Math.floor((t - 0.35) * rate)); i <= Math.min(lv.length - 1, Math.floor((t + 0.35) * rate)); i++) if (lv[i] > bv) { bv = lv[i]; bi = i; }
      if (bi >= 0) t = (bi + 0.5) / rate;
    }
    return { t, k };
  }).filter((x) => x.t >= 0.3 && x.t <= dur - 0.1).sort((a, b) => a.t - b.t);
  const groups = [];
  for (const x of pos) { const g = groups[groups.length - 1]; if (g && x.t - g[g.length - 1].t <= 3) g.push(x); else groups.push([x]); }
  return groups.map((g) => {
    const n = g.length;
    const score = g.reduce((t, x) => t + 1 + (x.k.hs ? 0.5 : 0) + (x.k.nth >= 3 ? 1 : 0), 0) + (n > 1 ? 1.5 * (n - 1) : 0);
    return { t: g[g.length - 1].t, score, kills: n, delay: best.delay };
  }).sort((a, b) => b.score - a.score).slice(0, 4);
}

/* ---------------- local server + storage ---------------- */
class Cs2 {
  constructor({ file, token, onChange = () => {}, onMatch = () => {} }) {
    this.file = file; this.token = token; this.onChange = onChange; this.onMatch = onMatch;
    this.port = null; this.lastDataAt = 0; this.server = null; this.matches = [];
    try { this.matches = JSON.parse(fs.readFileSync(file, 'utf8')).matches || []; } catch { this.matches = []; }
    this.rec = new Recorder({
      onFinished: (m) => { this.matches.push(m); this.save(); this.onMatch(m); this.onChange(); },
      onUpdate: () => this.onChange(),
    });
  }
  save() { try { const t = this.file + '.tmp'; fs.writeFileSync(t, JSON.stringify({ matches: this.matches })); fs.renameSync(t, this.file); } catch { /* disk problem: keep in memory */ } }

  listen(startPort = 3737) {
    return new Promise((resolve) => {
      const tryPort = (port) => {
        if (port > startPort + 9) return resolve(null);
        const server = http.createServer((req, res) => {
          if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
          let body = '', size = 0;
          req.on('data', (d) => { size += d.length; if (size > 2e6) req.destroy(); else body += d; });
          req.on('end', () => {
            res.writeHead(200); res.end();
            try {
              const p = JSON.parse(body);
              if (!p.auth || p.auth.token !== this.token) return; // not from CS2 with our key
              this.lastDataAt = Date.now();
              this.rec.handle(p, this.lastDataAt);
            } catch { /* ignore garbage */ }
          });
        });
        server.once('error', () => tryPort(port + 1));
        server.listen(port, '127.0.0.1', () => { this.server = server; this.port = port; this.timer = setInterval(() => this.rec.idleCheck(Date.now()), 30000); resolve(port); });
      };
      tryPort(startPort);
    });
  }
  stop() { clearInterval(this.timer); if (this.server) this.server.close(); }
  getMatch(id) { return this.matches.find((m) => m.id === id) || null; }
  remove(id) { this.matches = this.matches.filter((m) => m.id !== id); this.save(); this.onChange(); }
}

module.exports = { buildGsiConfig, CFG_NAME, Recorder, summarize, overview, insights, momentsForClip, Cs2, buyOf };
