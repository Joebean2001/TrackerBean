// Unlock Chain: play the current game for N minutes to unlock the next one.
// Nothing is ever blocked - it only decides which game the challenge is counting.
const defaults = () => ({ goalMin: 120, mode: 'random', current: null, completed: [], pending: false, finished: false, lastUnlock: null, excluded: [] });

// Minutes of play on the current game since it became the target.
function progressMs(data, now = Date.now()) {
  const q = data.quest;
  if (!q.current) return 0;
  let t = 0;
  for (const s of data.sessions) {
    if (s.gameId !== q.current.gameId) continue;
    const end = s.open ? now : s.end;
    t += Math.max(0, end - Math.max(s.start, q.current.since));
  }
  return t;
}

function candidates(data) {
  const q = data.quest;
  const done = new Set(q.completed.map((c) => c.gameId));
  const out = new Set(q.excluded || []); // games the player left out of the challenge
  return data.games.filter((g) => !done.has(g.id) && !out.has(g.id) && !(q.current && q.current.gameId === g.id));
}

function unlockNext(data, now = Date.now(), rand = Math.random) {
  const q = data.quest;
  q.current = null; q.lastUnlock = null;
  const pool = candidates(data);
  if (!pool.length) { q.finished = true; q.pending = false; return { type: 'finished' }; }
  if (q.mode === 'random') {
    const g = pool[Math.floor(rand() * pool.length)];
    q.current = { gameId: g.id, since: now };
    q.lastUnlock = { gameId: g.id, at: now };
    return { type: 'unlocked', game: g };
  }
  q.pending = true; // "I choose": wait for the player to pick
  return { type: 'pending' };
}

// Call regularly. Returns an event when the current goal was just reached, otherwise null.
function check(data, now = Date.now(), rand = Math.random) {
  const q = data.quest;
  if (!q.current || progressMs(data, now) < q.goalMin * 60000) return null;
  const completedGame = data.games.find((g) => g.id === q.current.gameId) || null;
  q.completed.push({ gameId: q.current.gameId, at: now, minutes: q.goalMin });
  return { ...unlockNext(data, now, rand), completedGame };
}
module.exports = { defaults, progressMs, candidates, unlockNext, check };
