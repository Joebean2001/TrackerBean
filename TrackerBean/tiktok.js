// TikTok-style editing: cuts that land on the beat, slow-motion on the big moment,
// zoom punches, white flashes and a colour boost. Everything is rendered with FFmpeg.
const { spawn } = require('child_process');

const SR_AUDIO = 48000;
const SLOW_SRC = 0.25, SPEED = 0.35, SLOW_OUT = SLOW_SRC / SPEED; // 0.25s of footage stretched to ~0.71s
const MAX_SEGS = 48; // every cut is one FFmpeg input, so keep the count (and memory use) sane

// Editing styles. `pat` = how many beats each cut lasts, repeated (e.g. phonk: quick, quick, long slow-mo payoff).
// punch = zoom pulse on every beat, shake = camera shake strength, bpm = tempo of the generated beat when no song is chosen.
const STYLES = {
  phonk:  { label: 'Phonk',     pat: [1, 1, 4], punch: 0.12, shake: 1.0, bpm: 130, rgb: true,  slow: true },
  hype:   { label: 'Hype',      pat: [1, 1, 2], punch: 0.09, shake: 0.7, bpm: 140, rgb: true,  slow: false },
  smooth: { label: 'Cinematic', pat: [4],       punch: 0.04, shake: 0.15, bpm: 100, rgb: false, slow: true },
};
const styleOf = (name) => STYLES[name] || STYLES.phonk;

/* ---------------- music: find the beat ---------------- */
function decodeMono(ffmpeg, file, sr = 22050, maxSec = 420) {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-t', String(maxSec), '-ac', '1', '-ar', String(sr), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const b = Buffer.concat(chunks);
      const n = b.length - (b.length % 4);
      if (!n) return resolve(null);
      const ab = new ArrayBuffer(n);
      new Uint8Array(ab).set(b.subarray(0, n));
      resolve(new Float32Array(ab));
    });
  });
}

// Returns { bpm, beatLen, firstBeat, confidence, duration } or null if there is no clear beat.
function detectBeats(x, sr) {
  const hop = 512, win = 1024, n = Math.floor((x.length - win) / hop);
  if (n < 300) return null;
  // two energy envelopes: bass only (kicks) and full band
  const a = 2 * Math.PI * 200 / sr;
  const low = new Float32Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); low[i] = y; }
  const envOf = (sig) => {
    const e = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; const o = i * hop; for (let j = 0; j < win; j++) s += sig[o + j] * sig[o + j]; e[i] = Math.log(1 + 300 * Math.sqrt(s / win)); }
    return e;
  };
  const eL = envOf(low), eF = envOf(x);
  const flux = new Float32Array(n);
  for (let i = 1; i < n; i++) flux[i] = Math.max(0, eL[i] - eL[i - 1]) + 0.5 * Math.max(0, eF[i] - eF[i - 1]);
  let mean = 0; for (let i = 0; i < n; i++) mean += flux[i]; mean /= n;
  for (let i = 0; i < n; i++) flux[i] = Math.max(0, flux[i] - mean * 0.5);

  const fr = sr / hop;
  const minL = Math.floor(fr * 60 / 200), maxL = Math.ceil(fr * 60 / 70);
  let bestL = minL, bestS = -Infinity;
  for (let L = minL; L <= maxL; L++) {
    let ac = 0; for (let i = 0; i + L < n; i++) ac += flux[i] * flux[i + L];
    ac /= (n - L);
    const bpm = 60 * fr / L, prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.8, 2));
    if (ac * prior > bestS) { bestS = ac * prior; bestL = L; }
  }
  const bpm0 = 60 * fr / bestL;
  const at = (t) => { const i = Math.floor(t); if (i < 0 || i + 1 >= n) return 0; const f = t - i; return flux[i] * (1 - f) + flux[i + 1] * f; };
  let best = { score: -1, bpm: bpm0, phase: 0 }, total = 0, count = 0;
  for (let bpm = bpm0 - 3; bpm <= bpm0 + 3.0001; bpm += 0.05) {
    const P = 60 * fr / bpm;
    for (let ph = 0; ph < P; ph += 0.5) {
      let sc = 0;
      for (let t = ph; t < n - 1; t += P) sc += at(t);
      total += sc; count++;
      if (sc > best.score) best = { score: sc, bpm, phase: ph };
    }
  }
  const confidence = best.score / (total / count + 1e-9);
  const beatLen = 60 / best.bpm;
  // flux frame i marks an attack that happened around sample i*hop + win - hop/2
  const firstBeat = ((best.phase * hop + win - hop / 2) / sr) % beatLen;
  return { bpm: best.bpm, beatLen, firstBeat, confidence, duration: x.length / sr };
}

/* ---------------- footage: find the big moments ---------------- */
// levels = dB per 1/rate seconds. Returns up to `max` loud moments at least `minSep` seconds apart.
function peakCandidates(levels, rate, duration, { max = 3, minSep = 3.2, range = 10 } = {}) {
  if (!levels.length) return [{ t: Math.max(0.5, duration - 1), score: -90 }]; // no sound: assume the action is at the end
  const w = Math.max(1, Math.round(0.3 * rate));
  const power = levels.map((db) => Math.pow(10, db / 10));
  const sm = power.map((_, i) => { let s = 0, c = 0; for (let j = Math.max(0, i - (w >> 1)); j <= Math.min(power.length - 1, i + (w >> 1)); j++) { s += power[j]; c++; } return 10 * Math.log10(s / c + 1e-12); });
  const top = Math.max(...sm);
  const idx = sm.map((v, i) => i).sort((a, b) => sm[b] - sm[a]);
  const out = [];
  for (const i of idx) {
    if (out.length >= max) break;
    if (sm[i] < top - range || sm[i] < -45) break; // only moments close to the clip's loudest
    const t = (i + 0.5) / rate;
    if (out.every((o) => Math.abs(o.t - t) >= minSep)) out.push({ t, score: sm[i] });
  }
  return out.length ? out : [{ t: Math.max(0.5, duration - 1), score: -90 }];
}

// How to cut one segment of D seconds around a moment at peakT (all in source-clip seconds).
function planSegment(dur, peakT, D, slowOn) {
  if (slowOn && D >= 1.7) {
    const rem = D - SLOW_OUT, slowStart = peakT - 0.08;
    if (slowStart < 0) return null;
    let pre = Math.min(rem * 0.62, slowStart), post = rem - pre;
    if (slowStart + SLOW_SRC + post > dur) {
      post = dur - slowStart - SLOW_SRC; pre = rem - post;
      if (post < 0.2 || pre > slowStart) return null;
    }
    return { mode: 'slow', srcStart: slowStart - pre, pre, post, span: pre + SLOW_SRC + post, T0: pre + (peakT - slowStart) / SPEED };
  }
  if (dur < D) return null;
  const ss = Math.max(0, Math.min(peakT - 0.62 * D, dur - D));
  return { mode: 'plain', srcStart: ss, span: D, T0: peakT - ss };
}


// Cut lengths for a style: the pattern in whole beats, never shorter than ~0.4s. With slow-mo on, the longest
// cut of the pattern is stretched to at least 1.7s so it has room for the slow-motion payoff.
function slotDurations(style, bl, slowOn, n, mult = 1) {
  const pat = style.pat, maxB = Math.max(...pat);
  let m = mult;
  while (Math.min(...pat) * m * bl < 0.4 && m < 8) m *= 2;
  return Array.from({ length: n }, (_, i) => {
    let b = pat[i % pat.length] * m;
    const feature = slowOn && pat[i % pat.length] === maxB && maxB > 1;
    if (feature && b * bl < 1.7) b = Math.ceil(1.7 / bl);
    return { dur: b * bl, slow: feature };
  });
}

// items: [{ id, path, mtime, duration, hasAudio, levels, rate, moments? }]. `moments` (from real game data or AI vision)
// replaces the loudness guess: [{ t, score }] in clip seconds.
function planTikTok(items, beat, { target = 60, slow = true, musicDuration = null, style = STYLES.phonk, fill = false } = {}) {
  const bl = beat.beatLen, slowOn = slow && style.slow !== false;
  const pool = [];
  for (const it of items) {
    const peaks = it.moments ? it.moments.map((m) => ({ t: m.t, score: m.score })) : peakCandidates(it.levels || [], it.rate || 1, it.duration, fill ? { max: 6, minSep: 2.2, range: 18 } : undefined);
    for (const pk of peaks) pool.push({ item: it, peakT: pk.t, score: pk.score });
  }
  pool.sort((a, b) => b.score - a.score);
  // few moments to work with? use longer cuts so the video isn't over in a few seconds
  let mult = 1;
  const avgOf = (m) => { const s = slotDurations(style, bl, slowOn, style.pat.length * 4, m); return s.reduce((t, x) => t + x.dur, 0) / s.length; };
  while (pool.length && pool.length * avgOf(mult) < Math.min(target, 20) && mult < 8) mult *= 2;
  const avg = avgOf(mult);
  let want = Math.max(1, Math.min(fill ? 400 : MAX_SEGS, Math.round(target / avg)));
  if (musicDuration && !fill) want = Math.min(want, Math.max(1, Math.floor((musicDuration - beat.firstBeat - 1.5) / avg)));
  const chrono = (a, b) => (a.item.mtime - b.item.mtime) || (a.peakT - b.peakT);
  let chosen = pool.slice(0, want);
  const spare = pool.slice(want);
  for (let guard = 0; guard < 40 && chosen.length; guard++) {
    chosen.sort(chrono);
    const slots = slotDurations(style, bl, slowOn, chosen.length, mult);
    const planned = chosen.map((c, i) => {
      const s = slots[i];
      let p = planSegment(c.item.duration, c.peakT, s.dur, s.slow);
      if (!p && s.slow) p = planSegment(c.item.duration, c.peakT, s.dur, false);
      return p ? { item: c.item, peakT: c.peakT, score: c.score, dur: s.dur, plan: p } : null;
    });
    const bad = planned.findIndex((x) => !x);
    if (bad < 0) return { segments: planned, total: planned.reduce((t, s) => t + s.dur, 0), candidates: pool.length };
    chosen.splice(bad, 1);
    if (spare.length) chosen.push(spare.shift());
  }
  return { segments: [], total: 0, candidates: pool.length };
}

/* ---------------- render ---------------- */
let filterCache = null;
// Which optional filters this FFmpeg build has (drawtext needs freetype; older builds may lack rgbashift).
function listFilters(ffmpeg) {
  if (filterCache) return Promise.resolve(filterCache);
  return new Promise((resolve) => {
    require('child_process').execFile(ffmpeg, ['-hide_banner', '-filters'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_e, out) => {
      const s = String(out || '');
      filterCache = { drawtext: /\bdrawtext\b/.test(s), rgbashift: /\brgbashift\b/.test(s), vignette: /\bvignette\b/.test(s) };
      resolve(filterCache);
    });
  });
}

// A simple generated beat (kick, snare, hats, sub bass) for when no song is chosen. Lines up with cuts: beat 1 is at t=0.
function synthBeatSource(bl, seconds) {
  const B = bl.toFixed(5);
  const kick = `0.9*sin(2*PI*(45*mod(t,${B})+4.8*(1-exp(-25*mod(t,${B})))))*exp(-7*mod(t,${B}))`;
  const snare = `eq(mod(floor(t/${B}),2),1)*0.4*(random(1)*2-1)*exp(-16*mod(t,${B}))`;
  const hat = `0.14*(random(2)*2-1)*exp(-70*mod(t+${B}/2,${B}))`;
  const sub = `0.35*sin(2*PI*49*t)*exp(-1.2*mod(t,${B}*2))`;
  return `aevalsrc=exprs='0.7*(${kick}+${snare}+${hat}+${sub})':s=48000:d=${seconds.toFixed(3)}`;
}

// Returns { args, tail, filter, total }. The filter graph is long, so the caller writes `filter` to a file
// and passes it with -filter_complex_script (Windows limits the length of a command line).
// o.framing: 'fit' (black bars), 'blur' (blurred copy behind) or 'fill' (crop to fill). o.synth = { beatLen } plays a generated beat.
function buildTikTokArgs(plan, o) {
  const { width: W, height: H, fps: F = 60, music = null, synth = null, firstBeat = 0, beatLen = 0.469, clipVol = 100, musicVol = 80, fx = {}, style = STYLES.phonk,
    framing = 'fit', caption = '', captionFont = '', has = {}, chunk = false, t0 = 0, idx0 = 0, output } = o;
  const N = plan.segments.length;
  const starts = [0];
  plan.segments.forEach((s) => starts.push(starts[starts.length - 1] + s.dur));
  const total = starts[N];
  const cv = (Math.max(0, Math.min(100, clipVol)) / 100).toFixed(2);
  // t0 = where this piece starts in the whole video, so frame and sample counts add up exactly across pieces
  const frameAt = (k) => Math.round((t0 + starts[k]) * F), sampleAt = (k) => Math.round((t0 + starts[k]) * SR_AUDIO);
  const f = [], args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'];
  const AFMT = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const even = (n) => 2 * Math.max(1, Math.round(n / 2));
  const BL = beatLen.toFixed(5);
  const useRgb = fx.rgb && style.rgb && has.rgbashift !== false;
  const shakePx = Math.max(2, Math.round(W * 0.006 * style.shake));
  const rgbPx = Math.max(4, Math.round(W * 0.008));

  plan.segments.forEach((sg, i) => {
    const { item, plan: p } = sg;
    args.push('-ss', p.srcStart.toFixed(3), '-t', (p.span + 0.4).toFixed(3), '-i', item.path);
    const NF = frameAt(i + 1) - frameAt(i), NS = sampleAt(i + 1) - sampleAt(i);
    const tail = `setsar=1,fps=${F},format=yuv420p,setpts=PTS-STARTPTS`;
    let head; // starts with the input label(s) so it can be followed by ",split=3[...]" or "[sg_i]"
    if (framing === 'blur') {
      const bw = even(W / 8), bh = even(H / 8);
      f.push(`[${i}:v:0]split=2[bg${i}][fg${i}]`,
        `[bg${i}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=2:1,scale=${W}:${H},eq=brightness=-0.12:saturation=0.9[bb${i}]`,
        `[fg${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease[ff${i}]`);
      head = `[bb${i}][ff${i}]overlay=(W-w)/2:(H-h)/2,${tail}`;
    } else if (framing === 'fill') {
      head = `[${i}:v:0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},${tail}`;
    } else {
      head = `[${i}:v:0]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,${tail}`;
    }
    if (p.mode === 'slow') {
      const a = p.pre, b = a + SLOW_SRC, c = b + p.post;
      f.push(`${head},split=3[b0_${i}][b1_${i}][b2_${i}]`,
        `[b0_${i}]trim=end=${a.toFixed(3)},setpts=PTS-STARTPTS[s0_${i}]`,
        `[b1_${i}]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=(PTS-STARTPTS)/${SPEED},fps=${F}[s1_${i}]`,
        `[b2_${i}]trim=start=${b.toFixed(3)}:end=${c.toFixed(3)},setpts=PTS-STARTPTS[s2_${i}]`,
        `[s0_${i}][s1_${i}][s2_${i}]concat=n=3:v=1:a=0[sg_${i}]`);
    } else {
      f.push(`${head}[sg_${i}]`);
    }
    // exact frame count so cuts never drift away from the beat, then the effects
    let chain = `[sg_${i}]tpad=stop_mode=clone:stop=8,trim=end_frame=${NF},setpts=PTS-STARTPTS`;
    if (fx.zoom) {
      // zoom + shake: a punch on the big moment, plus a smaller pulse on every beat (segments start on a beat)
      const T0 = Math.max(0.05, p.T0).toFixed(3);
      const pk = `gte(t,${T0})*max(0,1-(t-${T0})/0.3)`;
      const bt = `exp(-5*mod(t,${BL})/${BL})`;
      const zoom = `(1+0.09*${pk}+${style.punch}*${bt})`;
      chain += `,scale=w='2*trunc(iw*${zoom}/2)':h='2*trunc(ih*${zoom}/2)':eval=frame:flags=bilinear,crop=${W}:${H}:x='(iw-ow)/2+${shakePx}*sin(t*95)*(${pk}+0.7*${bt})':y='(ih-oh)/2+${shakePx}*cos(t*83)*(${pk}+0.7*${bt})'`;
    }
    if (useRgb) { // RGB split glitch right after each cut and on the big moment
      const T0 = Math.max(0.05, p.T0).toFixed(3);
      chain += `,rgbashift=rh=-${rgbPx}:bh=${rgbPx}:enable='lt(t,0.12)+between(t,${T0},${(+T0 + 0.18).toFixed(3)})'`;
    }
    if (fx.flash && i + idx0 > 0) chain += ',fade=t=in:st=0:d=0.1:color=white';
    if (fx.grade) chain += ',eq=contrast=1.1:saturation=1.3,unsharp=5:5:0.5';
    f.push(`${chain}[v${i}]`);

    // clip audio: the real sound, but silent during the slow-motion
    const fix = `apad,atrim=end_sample=${NS},asetpts=PTS-STARTPTS,volume=${cv}[a${i}]`;
    if (!item.hasAudio) f.push(`anullsrc=r=48000:cl=stereo,${fix}`);
    else if (p.mode === 'slow') {
      const a = p.pre, b = a + SLOW_SRC, c = b + p.post;
      f.push(`[${i}:a:0]${AFMT},asetpts=PTS-STARTPTS,asplit=2[c0_${i}][c2_${i}]`,
        `[c0_${i}]atrim=end=${a.toFixed(3)},asetpts=PTS-STARTPTS[t0_${i}]`,
        `anullsrc=r=48000:cl=stereo,atrim=0:${SLOW_OUT.toFixed(3)},asetpts=PTS-STARTPTS[t1_${i}]`,
        `[c2_${i}]atrim=start=${b.toFixed(3)}:end=${c.toFixed(3)},asetpts=PTS-STARTPTS[t2_${i}]`,
        `[t0_${i}][t1_${i}][t2_${i}]concat=n=3:v=0:a=1,${fix}`);
    } else f.push(`[${i}:a:0]${AFMT},asetpts=PTS-STARTPTS,${fix}`);
  });

  f.push(`${plan.segments.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${N}:v=1:a=1[vcat][aj]`);

  // finishing touches over the whole video: vignette and caption
  const post = [];
  if (fx.grade && has.vignette !== false) post.push('vignette=PI/5');
  const text = String(caption || '').replace(/[\r\n]+/g, ' ').trim().toUpperCase().slice(0, 80);
  if (text && captionFont && has.drawtext !== false) {
    // shrink long captions so they always fit inside the frame (about 0.62 x font size per character)
    const capSize = Math.max(24, Math.min(Math.round(Math.min(W, H) * 0.085), Math.floor((W * 0.9) / (text.length * 0.62))));
    const esc = (s) => s.replace(/\\/g, '/').replace(/'/g, '').replace(/:/g, '\\:');
    post.push(`drawtext=fontfile='${esc(captionFont)}':textfile='${esc(o.captionFile || '')}':expansion=none:fontsize=${capSize}:fontcolor=white:borderw=${Math.max(3, Math.round(Math.min(W, H) * 0.008))}:bordercolor=black:x=(w-text_w)/2:y=h*0.74`);
  }
  f.push(post.length ? `[vcat]${post.join(',')}[vout]` : '[vcat]null[vout]');

  if (music || synth) {
    if (music) args.push('-ss', firstBeat.toFixed(3), '-i', music);
    else args.push('-f', 'lavfi', '-i', synthBeatSource(synth.beatLen, total + 1));
    const mv = (Math.max(0, Math.min(100, musicVol)) / 100).toFixed(2);
    f.push(`[${N}:a:0]${AFMT},atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS${synth && !music ? ',alimiter=limit=0.95' : ''},afade=t=out:st=${Math.max(0, total - 1.5).toFixed(3)}:d=1.5,volume=${mv}[mus]`,
      '[aj][mus]amix=inputs=2:duration=first:normalize=0[aout]');
  } else f.push('[aj]anull[aout]');

  const tailArgs = chunk
    ? ['-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(F), '-c:a', 'pcm_s16le', output]
    : ['-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', String(F),
      '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3), '-movflags', '+faststart', output];
  return { args, tail: tailArgs, filter: f.join(';\n'), total };
}
// Joins rendered pieces (list = concat-demuxer text file) and lays the song (or generated beat) under them.
function buildJoinArgs({ list, music = null, synth = null, firstBeat = 0, musicVol = 80, total, output }) {
  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-f', 'concat', '-safe', '0', '-i', list];
  const AFMT = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const enc = ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3), '-movflags', '+faststart', output];
  if (!music && !synth) return { args: [...args, '-map', '0:v:0', '-map', '0:a:0', ...enc], total };
  if (music) args.push('-ss', firstBeat.toFixed(3), '-i', music);
  else args.push('-f', 'lavfi', '-i', synthBeatSource(synth.beatLen, total + 1));
  const mv = (Math.max(0, Math.min(100, musicVol)) / 100).toFixed(2);
  const filter = `[0:a:0]${AFMT}[aj];[1:a:0]${AFMT},atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS${!music ? ',alimiter=limit=0.95' : ''},afade=t=out:st=${Math.max(0, total - 1.5).toFixed(3)}:d=1.5,volume=${mv}[mus];[aj][mus]amix=inputs=2:duration=first:normalize=0[aout]`;
  return { args: [...args, '-filter_complex', filter, '-map', '0:v:0', '-map', '[aout]', ...enc], total };
}
module.exports = { STYLES, styleOf, decodeMono, detectBeats, peakCandidates, planSegment, planTikTok, buildTikTokArgs, buildJoinArgs, listFilters };
