// SPDX-License-Identifier: GPL-3.0-only
// A small XML reader and writer: enough for interchange formats (DAWproject), with no DOM, so it runs in the page,
// in a worker and under Node alike. Elements, attributes, text, CDATA, comments, the five entities and numeric ones.

export function parseXml(src) {
  let i = 0;
  const n = src.length;
  const root = { name: '#doc', attrs: {}, children: [], text: '' };
  const stack = [root];
  const ent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
  });
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) stack.at(-1).text += ent(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); stack.at(-1).text += src.slice(lt + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3; continue; }
    if (src[lt + 1] === '?' || src[lt + 1] === '!') { const e = src.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    if (src[lt + 1] === '/') {                                    // a closing tag
      const e = src.indexOf('>', lt);
      const name = src.slice(lt + 2, e).trim();
      while (stack.length > 1) { const top = stack.pop(); if (top.name === name) break; }   // (tolerant of a missing close)
      i = e + 1;
      continue;
    }
    // an opening tag: its name, its attributes, maybe self-closed
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const el = { name: src.slice(lt + 1, j), attrs: {}, children: [], text: '' };
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '/' || src[j] === '>' || j >= n) break;
      let k = j;
      while (k < n && !/[\s=/>]/.test(src[k])) k++;
      const an = src.slice(j, k);
      j = k;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '=') {
        j++;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") { const e = src.indexOf(q, j + 1); el.attrs[an] = ent(src.slice(j + 1, e < 0 ? n : e)); j = e < 0 ? n : e + 1; }
        else { let e = j; while (e < n && !/[\s>]/.test(src[e])) e++; el.attrs[an] = ent(src.slice(j, e)); j = e; }
      } else el.attrs[an] = '';
    }
    stack.at(-1).children.push(el);
    if (src[j] === '/') { i = src.indexOf('>', j) + 1; continue; }
    stack.push(el);
    i = j + 1;
  }
  return root.children.find((c) => c.name) || null;
}
// helpers on a parsed element
export const kids = (el, name) => (el?.children || []).filter((c) => !name || c.name === name);
export const kid = (el, name) => (el?.children || []).find((c) => c.name === name) || null;
export const num = (el, a, d = 0) => { const v = el?.attrs?.[a]; if (v == null || v === '') return d; if (v === 'inf') return Infinity; if (v === '-inf') return -Infinity; const x = Number(v); return Number.isFinite(x) ? x : d; };

// writing: x('Name', {attr: value}, ...children) -> a string; null / undefined attributes and children are left out
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? String(+v.toFixed(9)) : v > 0 ? 'inf' : '-inf') : typeof v === 'boolean' ? String(v) : esc(v));
export function x(name, attrs = {}, ...children) {
  const a = Object.entries(attrs || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => ` ${k}="${fmt(v)}"`).join('');
  const c = children.flat(Infinity).filter((v) => v != null && v !== false);
  return c.length ? `<${name}${a}>${c.join('')}</${name}>` : `<${name}${a}/>`;
}
// with line breaks and indentation, for people reading the file
export function pretty(xml) {
  let depth = 0;
  return xml.replace(/(<\/?[^>]+>)/g, '\n$1').split('\n').filter(Boolean).map((line) => {
    if (line.startsWith('</')) depth--;
    const out = '  '.repeat(Math.max(0, depth)) + line;
    if (!line.startsWith('</') && !line.endsWith('/>') && !line.startsWith('<?')) depth++;
    return out;
  }).join('\n').replace(/(<([\w.]+)[^>]*>)\n\s*(<\/\2>)/g, '$1$3');
}
