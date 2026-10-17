// Watches running programs and turns "game exe appeared / disappeared" into sessions.
const { execFile } = require('child_process');
const crypto = require('crypto');

const POLL_MS = 5000;
const MIN_SESSION_MS = 60 * 1000;   // sessions shorter than this are dropped
const STALE_MS = 60 * 1000;         // an open session unseen this long is closed (crash / reboot)

// tasklist cuts image names at 25 characters, so compare names the same way.
const norm = (n) => String(n).toLowerCase().slice(0, 25);

function listProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(new Set());
    execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null); // unknown: don't end sessions on a failed read
      const names = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)"/);
        if (m) names.add(norm(m[1]));
      }
      resolve(names);
    });
  });
}

class Tracker {
  constructor(store, onChange, lister = listProcesses) {
    this.store = store;
    this.onChange = onChange || (() => {});
    this.lister = lister;
    this.busy = false;
  }
  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }
  stop() { clearInterval(this.timer); }

  closeSession(s) {
    s.open = false;
    s.end = s.lastSeen;
    if (s.end - s.start < MIN_SESSION_MS) {
      this.store.data.sessions = this.store.data.sessions.filter((x) => x.id !== s.id);
    }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const running = await this.lister();
      if (!running) return;
      const now = Date.now();
      const d = this.store.data;
      let changed = false;

      for (const game of d.games) {
        const isRunning = game.exes.some((e) => running.has(norm(e)));
        let open = d.sessions.find((s) => s.open && s.gameId === game.id);

        if (open && now - open.lastSeen > STALE_MS) { // gap: app was closed or PC restarted
          this.closeSession(open); open = null; changed = true;
        }
        if (isRunning && !open) {
          d.sessions.push({ id: crypto.randomUUID(), gameId: game.id, start: now, end: null, lastSeen: now, open: true });
          changed = true;
        } else if (isRunning && open) {
          open.lastSeen = now; // heartbeat
        } else if (!isRunning && open) {
          this.closeSession(open); changed = true;
        }
      }
      // sessions of games that were removed
      const ids = new Set(d.games.map((g) => g.id));
      d.sessions = d.sessions.filter((s) => ids.has(s.gameId));

      this.store.save();
      if (changed) this.onChange();
    } finally {
      this.busy = false;
    }
  }
}
module.exports = { Tracker, norm, MIN_SESSION_MS };
