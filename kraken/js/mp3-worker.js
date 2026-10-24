// SPDX-License-Identifier: GPL-3.0-only
// One MP3, encoded in a Web Worker (mp3.js): the page stays smooth, and stems encode side by side.
import { encodeMp3 } from './mp3.js';

onmessage = async ({ data: m }) => {
  try {
    let last = 0;
    const file = await encodeMp3(m.L, m.R, m.rate, m.kbps, { title: m.title, onProgress: (v) => { if (v - last >= 0.05 || v === 1) { last = v; postMessage({ progress: v }); } } });
    postMessage({ file }, [file.buffer]);
  } catch (e) { postMessage({ error: e?.message || String(e) }); }
};
