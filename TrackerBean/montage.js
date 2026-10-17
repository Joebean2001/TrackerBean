// Clip discovery, probing, thumbnails and montage rendering (via FFmpeg).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|avi)$/i;
const SKIP_DIRS = /^(TrackerBean Montages|GameHub Montages|\$RECYCLE\.BIN|System Volume Information|node_modules)$/i;

const clipId = (file) => crypto.createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 16);

// All video files in a folder (and a few levels below it), newest first.
function scanClips(root, maxFiles = 5000) {
  const out = [];
  const stack = [[root, 0]];
  while (stack.length && out.length < maxFiles) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && VIDEO_EXT.test(e.name)) {
        try {
          const st = fs.statSync(full);
          if (st.size > 50 * 1024) out.push({ id: clipId(full), path: full, name: e.name, folder: path.basename(dir), mtime: Math.round(st.mtimeMs), size: st.size });
        } catch { /* unreadable file */ }
      } else if (e.isDirectory() && depth < 4 && !SKIP_DIRS.test(e.name)) stack.push([full, depth + 1]);
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function parseProbe(text) {
  const dur = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : 0;
  const vline = (text.match(/Stream #[^\n]*Video:[^\n]*/) || [''])[0];
  const size = vline.match(/,\s*(\d{2,5})x(\d{2,5})/);
  return { duration, hasAudio: /Stream #[^\n]*Audio:/.test(text), w: size ? +size[1] : 0, h: size ? +size[2] : 0 };
}

function probe(ffmpeg, file) {
  return new Promise((resolve) => {
    // ffmpeg exits with an error when no output is given, but still prints the file info.
    execFile(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_err, _out, stderr) => resolve(parseProbe(String(stderr || ''))));
  });
}

function thumbnail(ffmpeg, file, outFile, duration) {
  return new Promise((resolve) => {
    const at = Math.max(0, Math.min(2, duration / 2)).toFixed(2);
    execFile(ffmpeg, ['-hide_banner', '-y', '-ss', at, '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', outFile],
      { windowsHide: true }, (err) => resolve(!err && fs.existsSync(outFile)));
  });
}

// Builds the ffmpeg arguments for a montage.
// clips: [{ path, duration, hasAudio }]; opts: { transition, width, height, fps, trimLast, clipVol, musicVol, music, output }
function buildArgs(clips, opts) {
  const { transition, width: W, height: H, fps, trimLast = 0, clipVol = 100, musicVol = 60, music = null, output } = opts;
  const items = clips.map((c) => {
    if (c.keep != null) { // the auto-editor already chose which part of the clip to use
      const ss = Math.max(0, Math.min(c.ss || 0, c.duration - 0.5));
      return { ...c, ss, dur: Math.min(c.keep, c.duration - ss) };
    }
    const keep = trimLast > 0 ? Math.min(c.duration, trimLast) : c.duration;
    return { ...c, ss: Math.max(0, c.duration - keep), dur: keep };
  });
  const n = items.length;
  const minDur = Math.min(...items.map((i) => i.dur));
  let X = transition === 'cut' || n < 2 ? 0 : Math.min(0.6, minDur / 3);
  if (X < 0.1) X = 0;
  const xname = transition === 'fadeblack' ? 'fadeblack' : 'fade';

  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'];
  for (const it of items) {
    if (it.ss > 0.05) args.push('-ss', it.ss.toFixed(3));
    args.push('-t', it.dur.toFixed(3), '-i', it.path);
  }
  const musicIdx = n;
  if (music) args.push('-stream_loop', '-1', '-i', music);

  const f = [];
  items.forEach((it, i) => {
    f.push(`[${i}:v:0]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${i}]`);
    f.push(it.hasAudio
      ? `[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=0:${it.dur.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
  });

  let total;
  if (n === 1) {
    f.push('[v0]null[vout]', '[a0]anull[aj]');
    total = items[0].dur;
  } else if (X === 0) {
    f.push(`${items.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${n}:v=1:a=1[vout][aj]`);
    total = items.reduce((t, i) => t + i.dur, 0);
  } else {
    let len = items[0].dur, pv = 'v0', pa = 'a0';
    for (let k = 1; k < n; k++) {
      const lastK = k === n - 1;
      f.push(`[${pv}][v${k}]xfade=transition=${xname}:duration=${X.toFixed(3)}:offset=${(len - X).toFixed(3)}[${lastK ? 'vout' : 'xv' + k}]`);
      f.push(`[${pa}][a${k}]acrossfade=d=${X.toFixed(3)}[${lastK ? 'aj' : 'xa' + k}]`);
      pv = 'xv' + k; pa = 'xa' + k;
      len = len + items[k].dur - X;
    }
    total = len;
  }

  const cv = (Math.max(0, Math.min(100, clipVol)) / 100).toFixed(2);
  if (music) {
    const mv = (Math.max(0, Math.min(100, musicVol)) / 100).toFixed(2);
    const fadeStart = Math.max(0, total - 2).toFixed(3);
    f.push(`[aj]volume=${cv}[ac]`);
    f.push(`[${musicIdx}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${total.toFixed(3)},afade=t=out:st=${fadeStart}:d=2,volume=${mv}[mus]`);
    f.push('[ac][mus]amix=inputs=2:duration=first:normalize=0[aout]');
  } else {
    f.push(`[aj]volume=${cv}[aout]`);
  }

  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-t', (total + 0.05).toFixed(3), '-movflags', '+faststart', output);
  return { args, total };
}

// Runs ffmpeg, reporting progress 0..1. Returns { promise, cancel }.
function run(ffmpeg, args, total, onProgress) {
  const child = spawn(ffmpeg, args, { windowsHide: true });
  let cancelled = false, tail = '', buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/); buf = lines.pop();
    for (const l of lines) {
      const m = l.match(/^out_time_(?:us|ms)=(\d+)/);
      if (m && total > 0) onProgress(Math.min(1, (+m[1] / 1e6) / total));
    }
  });
  child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-1500); });
  const promise = new Promise((resolve) => {
    child.on('error', (e) => resolve({ ok: false, cancelled, tail: String(e.message) }));
    child.on('close', (code) => resolve({ ok: code === 0 && !cancelled, cancelled, tail }));
  });
  return { promise, cancel: () => { cancelled = true; child.kill(); } };
}

// ---- automatic editing: find the loudest moments ----
// Loudness (dB) for each second of a clip's audio. Loud usually means action: gunfire, shouting, explosions.
function loudness(ffmpeg, file, rate = 1) {
  return new Promise((resolve) => {
    const af = `aresample=48000,asetnsamples=n=${Math.round(48000 / rate)}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`;
    execFile(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', af, '-f', 'null', '-'],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 90000 }, (err, stdout) => {
        const levels = [];
        let t = null;
        for (const line of String(stdout || '').split(/\r?\n/)) {
          const a = line.match(/pts_time:([\d.]+)/);
          if (a) { t = Math.round(parseFloat(a[1]) * rate); continue; }
          const b = line.match(/RMS_level=(-?[\d.]+|-inf|inf|nan)/i);
          if (b && t !== null) {
            const v = parseFloat(b[1]);
            levels[t] = Number.isFinite(v) ? Math.max(-90, v) : -90;
          }
        }
        for (let i = 0; i < levels.length; i++) if (levels[i] === undefined) levels[i] = -90;
        resolve(levels.map((v) => Math.round(v * 10) / 10));
      });
  });
}

// The `win`-second stretch with the highest average loudness. `rate` = levels per second.
function bestWindow(levels, duration, win, rate = 1) {
  const keep = Math.min(win, duration);
  const maxStart = Math.max(0, duration - keep);
  if (!levels.length) return { start: maxStart, score: -90 }; // no sound info: assume the action is at the end
  const power = levels.map((db) => Math.pow(10, db / 10));
  const w = Math.max(1, Math.round(keep * rate));
  const lastStart = Math.min(Math.floor(maxStart * rate), Math.max(0, power.length - w));
  let best = { idx: 0, score: -Infinity };
  let sum = 0;
  for (let i = 0; i < Math.min(w, power.length); i++) sum += power[i];
  for (let st = 0; st <= lastStart; st++) {
    if (st > 0) sum += power[st + w - 1] - power[st - 1];
    const score = 10 * Math.log10(Math.max(sum, 0) / w + 1e-12);
    if (score > best.score) best = { idx: st, score };
  }
  return { start: Math.min(best.idx / rate, maxStart), score: best.score };
}

// items: [{ id, mtime, duration, levels }]. Picks the most exciting clips up to ~target seconds,
// cuts each to its loudest stretch, and returns them in the order they happened.
function planAuto(items, { target = 60, winLen = 10 } = {}) {
  const scored = items.map((it) => {
    const keep = Math.min(winLen, it.duration);
    if (it.moments && it.moments.length) { // real game data: centre the window on the best moment
      const m = it.moments.reduce((a, b) => (b.score > a.score ? b : a));
      return { id: it.id, mtime: it.mtime, ss: Math.max(0, Math.min(m.t - 0.65 * keep, it.duration - keep)), keep, score: m.score };
    }
    const { start, score } = bestWindow(it.levels || [], it.duration, keep, it.rate || 1);
    return { id: it.id, mtime: it.mtime, ss: start, keep, score };
  }).sort((a, b) => b.score - a.score);
  const chosen = [];
  let total = 0;
  for (const c of scored) {
    if (chosen.length >= 40) break;
    if (chosen.length && total + c.keep > target * 1.15) continue; // too long, but a shorter clip may still fit
    chosen.push(c); total += c.keep;
    if (total >= target) break;
  }
  return chosen.sort((a, b) => a.mtime - b.mtime);
}
module.exports = { loudness, bestWindow, planAuto, scanClips, probe, thumbnail, buildArgs, run, parseProbe, clipId };
