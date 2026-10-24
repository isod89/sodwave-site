// SPDX-License-Identifier: GPL-3.0-only
// Warping off the page's thread: a long file stretches here while the app stays responsive.
import { stretchWarp, detectTransients } from './warp.js';

self.onmessage = ({ data: { id, op, L, R, opts } }) => {
  try {
    if (op === 'stretch') { const o = stretchWarp(L, R, opts); self.postMessage({ id, L: o.L, R: o.R }, [o.L.buffer, o.R.buffer]); }
    else if (op === 'transients') self.postMessage({ id, t: detectTransients(L, R) });
  } catch (e) { self.postMessage({ id, error: String(e?.message || e) }); }
};
