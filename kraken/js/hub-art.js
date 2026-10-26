// SPDX-License-Identifier: GPL-3.0-only
// A cover for whatever is published without a video: drawn from its id and title, the same every time, in Kraken's
// colours (the octopus's four tentacles). A song: its waveform over tentacle waves; a plugin: a LAB patch (modules and
// cables); a preset: a knob; a template: an arrangement of clips. Plain SVG text, no user text inside it.
const COLS = ['#FF621A', '#FFC618', '#1ECC70', '#2E82FF', '#E0458A', '#8B5CF6'];
function rng(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  let s = h >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const f1 = (x) => x.toFixed(1);
export function cover(seed, kind = 'song') {
  const r = rng(`${kind}:${seed}`), W = 320, H = 180;
  const c0 = Math.floor(r() * COLS.length), pal = [0, 1, 2, 3].map((i) => COLS[(c0 + i * (1 + Math.floor(r() * 2))) % COLS.length]);
  const hue = Math.floor(r() * 360);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">`;
  s += `<defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 45% 13%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 55% 5%)"/></linearGradient>`;
  s += `<radialGradient id="g" cx="${f1(0.2 + r() * 0.6)}" cy="${f1(0.2 + r() * 0.5)}" r="0.7"><stop offset="0" stop-color="${pal[0]}" stop-opacity="0.35"/><stop offset="1" stop-color="${pal[0]}" stop-opacity="0"/></radialGradient></defs>`;
  s += `<rect width="${W}" height="${H}" fill="url(#b)"/><rect width="${W}" height="${H}" fill="url(#g)"/>`;
  // the tentacles: soft waves across
  for (let k = 0; k < 4; k++) {
    const y0 = H * (0.3 + r() * 0.5), a = 10 + r() * 28, fq = 0.012 + r() * 0.02, ph = r() * 6.28;
    let d = '';
    for (let x = -10; x <= W + 10; x += 8) d += `${x === -10 ? 'M' : 'L'}${x} ${f1(y0 + a * Math.sin(x * fq + ph) * (0.6 + 0.4 * Math.sin(x * 0.006 + k)))}`;
    s += `<path d="${d}" fill="none" stroke="${pal[k]}" stroke-width="${f1(1.5 + r() * 2.5)}" stroke-opacity="${f1(0.35 + r() * 0.4)}" stroke-linecap="round"/>`;
  }
  if (kind === 'song') {                                            // a waveform, bars mirrored around the middle
    const n = 48, bw = 4, gap = 2, x0 = (W - n * (bw + gap)) / 2, cy = H * 0.52;
    let env = 0.3 + r() * 0.4;
    for (let i = 0; i < n; i++) {
      env += (r() - 0.5) * 0.25; env = Math.max(0.15, Math.min(1, env));
      const hh = 6 + env * 46 * (0.6 + 0.4 * r());
      s += `<rect x="${f1(x0 + i * (bw + gap))}" y="${f1(cy - hh / 2)}" width="${bw}" height="${f1(hh)}" rx="2" fill="#fff" fill-opacity="${f1(0.55 + 0.4 * (i % 4 === 0 ? 1 : r()))}"/>`;
    }
  } else if (kind === 'plugin') {                                   // a patch: modules and cables
    const nodes = [...Array(4 + Math.floor(r() * 3))].map((_, i, a) => ({ x: 40 + (i / (a.length - 1)) * (W - 80) + (r() - 0.5) * 20, y: 40 + r() * (H - 80) }));
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1], b = nodes[i], mx = (a.x + b.x) / 2;
      s += `<path d="M${f1(a.x)} ${f1(a.y)}C${f1(mx)} ${f1(a.y + 30)} ${f1(mx)} ${f1(b.y + 30)} ${f1(b.x)} ${f1(b.y)}" fill="none" stroke="${pal[i % 4]}" stroke-width="2.5" stroke-opacity="0.9"/>`;
    }
    for (const [i, n] of nodes.entries()) s += `<rect x="${f1(n.x - 22)}" y="${f1(n.y - 14)}" width="44" height="28" rx="6" fill="#0b0c0d" stroke="${pal[i % 4]}" stroke-width="1.6"/><circle cx="${f1(n.x - 22)}" cy="${f1(n.y)}" r="3.5" fill="${pal[i % 4]}"/><circle cx="${f1(n.x + 22)}" cy="${f1(n.y)}" r="3.5" fill="${pal[(i + 1) % 4]}"/>`;
  } else if (kind === 'preset') {                                   // a big knob
    const cx = W / 2, cy = H / 2, R = 46, v = 0.15 + r() * 0.7, A0 = Math.PI * 0.75, A1 = A0 + v * Math.PI * 1.5;
    const pt = (a, rr) => `${f1(cx + Math.cos(a) * rr)} ${f1(cy + Math.sin(a) * rr)}`;
    s += `<path d="M${pt(A0, R)}A${R} ${R} 0 1 1 ${pt(Math.PI * 2.25, R)}" fill="none" stroke="#ffffff22" stroke-width="7" stroke-linecap="round"/>`;
    s += `<path d="M${pt(A0, R)}A${R} ${R} 0 ${v > 0.66 ? 1 : 0} 1 ${pt(A1, R)}" fill="none" stroke="${pal[0]}" stroke-width="7" stroke-linecap="round"/>`;
    s += `<circle cx="${cx}" cy="${cy}" r="32" fill="#d6d7d4"/><line x1="${cx}" y1="${cy}" x2="${pt(A1, 26).split(' ')[0]}" y2="${pt(A1, 26).split(' ')[1]}" stroke="#131415" stroke-width="5" stroke-linecap="round"/>`;
  } else {                                                          // a template: lanes of clips
    for (let l = 0; l < 4; l++) {
      let x = 24 + r() * 30;
      while (x < W - 40) { const w = 30 + r() * 70; s += `<rect x="${f1(x)}" y="${f1(30 + l * 32)}" width="${f1(Math.min(w, W - 24 - x))}" height="24" rx="4" fill="${pal[l]}" fill-opacity="0.85"/>`; x += w + 6 + r() * 30; }
    }
  }
  return s + '</svg>';
}
