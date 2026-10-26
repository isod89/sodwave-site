// SPDX-License-Identifier: GPL-3.0-only
// Sounds Kraken makes itself, the same every time: a style that needs a sound none of the engines has gets it here, as
// a sample for the sampler. Generated from a fixed recipe (a seeded noise), so a project that uses one never misses
// it: a browser without it makes it again (main.js, on opening). No DOM: the tests run it under Node.
const RATE = 44100;
const TAU = Math.PI * 2;

// a seeded noise, the same sequence each time
function noise(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2147483648 - 1; }; }

// The amapiano LOG DRUM: a round, hollow, pitched thump. A sine whose pitch falls fast from about an octave above
// (the knock), a wooden overtone a little under three times higher that dies in tens of milliseconds (the "log"),
// a faint second one, a click of filtered noise, all through a soft clip for weight. Root: C2 (MIDI 36).
function logDrum() {
  const n = Math.round(RATE * 1.1), L = new Float32Array(n), rnd = noise(36);
  const f0 = 65.406;
  let ph1 = 0, ph2 = 0, ph3 = 0, bp1 = 0, bp2 = 0;
  // the click: a band-pass around 1.8 kHz (a two-pole resonator)
  const w = TAU * 1800 / RATE, r = 0.93, a1 = 2 * r * Math.cos(w), a2 = -r * r;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const f = f0 * (1 + 0.85 * Math.exp(-t / 0.011) + 0.06 * Math.exp(-t / 0.09));
    ph1 += TAU * f / RATE; ph2 += TAU * f * 2.76 / RATE; ph3 += TAU * f * 5.4 / RATE;
    const att = Math.min(1, t / 0.0015);
    const body = Math.sin(ph1) * Math.exp(-t / 0.3) * att;
    const wood = Math.sin(ph2) * 0.42 * Math.exp(-t / 0.045) * att + Math.sin(ph3) * 0.12 * Math.exp(-t / 0.018) * att;
    const x = rnd() * Math.exp(-t / 0.003);
    const y = x + a1 * bp1 + a2 * bp2; bp2 = bp1; bp1 = y;
    const click = y * 0.05;
    L[i] = Math.tanh((body + wood + click) * 1.8) / Math.tanh(1.8);
  }
  // the end faded to silence, the peak at -1 dB
  const fade = Math.round(RATE * 0.05);
  for (let i = 0; i < fade; i++) L[n - 1 - i] *= i / fade;
  let pk = 0; for (const v of L) pk = Math.max(pk, Math.abs(v));
  const g = 0.89 / (pk || 1); for (let i = 0; i < n; i++) L[i] *= g;
  return L;
}

export const GENERATED = {
  'gen-logdrum-1': { name: 'LOG DRUM', root: 36, make: logDrum },
};
const made = new Map();
// a generated sound by its id -> { L, R, name } (made once, then shared), or null for any other id
export function genSound(id) {
  const g = GENERATED[id];
  if (!g) return null;
  if (!made.has(id)) { const L = g.make(); made.set(id, { L, R: L, name: g.name }); }
  return made.get(id);
}
