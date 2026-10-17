// AI highlight detection: sample frames from a clip with FFmpeg, let Claude score each one for how
// highlight-worthy it is (kills, headshots, explosions, clutch moments vs. menus and death screens),
// then snap the best frames to the loudest instant nearby (the actual gunshot / explosion).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MODEL = 'claude-sonnet-5-5';
const MAX_FRAMES = 32;

function extractFrames(ffmpeg, file, duration) {
  return new Promise((resolve) => {
    const n = Math.max(6, Math.min(MAX_FRAMES, Math.floor(duration)));
    const step = duration / n;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trackerbean-vision-'));
    const done = (frames) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } resolve(frames); };
    execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', (step / 2).toFixed(3), '-i', file, '-an',
      '-vf', `fps=1/${step.toFixed(4)},scale=448:-2`, '-frames:v', String(n), '-q:v', '6', path.join(dir, 'f%03d.jpg')],
    { windowsHide: true, timeout: 120000 }, () => {
      const frames = [];
      for (let i = 0; i < n; i++) {
        try { frames.push({ t: +(step / 2 + i * step).toFixed(2), img: fs.readFileSync(path.join(dir, `f${String(i + 1).padStart(3, '0')}.jpg`)).toString('base64') }); } catch { break; }
      }
      done(frames);
    });
  });
}

async function scoreFrames(key, frames, gameName) {
  const content = [];
  for (const f of frames) content.push({ type: 'text', text: `Frame at ${f.t}s:` }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.img } });
  content.push({ type: 'text', text: `These are evenly spaced frames from one ${gameName ? gameName + ' ' : ''}gameplay clip. Score each frame 0-10 for how highlight-worthy it is for a TikTok montage. High: eliminations, kill-feed popups, headshots, hit markers, explosions, clutch or close-call moments, big action. Low: menus, loading, spectating, death screens, idle or empty scenes. Reply with ONLY a JSON array like [{"t":1.5,"score":7}], one entry per frame.` });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 3000, messages: [{ role: 'user', content }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || `API ${r.status}`); e.status = r.status; throw e; }
  const txt = (j.content || []).map((c) => c.text || '').join('');
  const m = txt.match(/\[[\s\S]*\]/);
  const arr = JSON.parse(m ? m[0] : txt);
  return arr.filter((x) => Number.isFinite(+x.t) && Number.isFinite(+x.score)).map((x) => ({ t: +x.t, score: Math.max(0, Math.min(10, +x.score)) }));
}

// Loudest tenth of a second within +-0.7s of t.
function snapToAudio(t, levels, rate, duration) {
  if (!levels || !levels.length) return t;
  let bi = -1, bv = -Infinity;
  for (let i = Math.max(0, Math.floor((t - 0.7) * rate)); i <= Math.min(levels.length - 1, Math.floor((t + 0.7) * rate)); i++) if (levels[i] > bv) { bv = levels[i]; bi = i; }
  return bi >= 0 ? Math.min(duration - 0.1, (bi + 0.5) / rate) : t;
}

// Returns moments [{ t, score }] for one clip: the best-scoring frames at least 2.5s apart.
async function findMoments(ffmpeg, key, item, gameName) {
  const frames = await extractFrames(ffmpeg, item.path, item.duration);
  if (frames.length < 3) return [];
  const scored = (await scoreFrames(key, frames, gameName)).sort((a, b) => b.score - a.score);
  const out = [];
  for (const p of scored) {
    if (out.length >= 3) break;
    if (p.score < 5 && out.length >= 1) break;       // keep weaker frames only if nothing better exists
    if (p.score < 3) break;
    if (out.every((o) => Math.abs(o.t - p.t) >= 2.5)) {
      const t = snapToAudio(p.t, item.levels, item.rate || 10, item.duration);
      const loud = item.levels && item.levels.length ? Math.max(0, Math.min(1, (item.levels[Math.min(item.levels.length - 1, Math.floor(t * (item.rate || 10)))] + 60) / 60)) : 0;
      out.push({ t, score: p.score + loud * 0.9 }); // loudness only breaks ties between similar frames
    }
  }
  return out;
}

module.exports = { findMoments };
