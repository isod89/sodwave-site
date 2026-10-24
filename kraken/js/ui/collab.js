// SPDX-License-Identifier: GPL-3.0-only
// PLAY TOGETHER: invite someone (a code to send them, their code back), or join with a code; then who is here, and
// the track each one is on (a coloured mark on its head).
import { h } from './kit.js';

export function collabDialog(app) {
  const c = app.collab;
  const status = h('p', { class: 'hint' });
  const name = h('input', { value: c.me.name, maxlength: 16, 'aria-label': 'Your name', onkeydown: (e) => e.stopPropagation(), onchange: (e) => c.setName(e.target.value) });
  const area = (ph, ro = false) => h('textarea', { class: 'collab-code', rows: 4, spellcheck: 'false', placeholder: ph, readonly: ro ? true : null, onkeydown: (e) => e.stopPropagation() });
  const copy = (ta) => h('button', { class: 'add', onclick: async () => { ta.select(); try { await navigator.clipboard.writeText(ta.value); app.toast('Copied.'); } catch { document.execCommand?.('copy'); } } }, 'COPY');
  const body = h('div', { class: 'collab-body' });
  const people = () => {
    const open = c.open;
    return open.length ? h('div', { class: 'collab-people' }, h('b', { text: 'HERE: ' }), h('span', { text: c.me.name, style: { color: c.me.color } }),
      ...open.map((x) => h('span', { text: ` · ${x.name}`, style: { color: x.color } }))) : null;
  };
  const home = () => {
    body.replaceChildren(
      people() || h('p', { class: 'hint', text: 'Make music with someone, each on their own computer, live: every change is heard and seen by both. Browser to browser, no account, no server of ours. Send codes by any chat.' }),
      h('label', { class: 'qz-row' }, h('span', { text: 'YOUR NAME' }), name),
      h('div', { class: 'row', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', { class: 'add go', onclick: invite }, 'INVITE SOMEONE'),
        h('button', { class: 'add', onclick: join }, 'JOIN WITH A CODE'),
        c.live ? h('button', { class: 'add danger', onclick: () => { c.leave(); home(); } }, 'LEAVE') : null),
      status);
  };
  const invite = async () => {
    status.textContent = 'Making the invitation…';
    let inv;
    try { inv = await c.invite(); } catch (e) { status.textContent = `Could not make it: ${e.message}`; return; }
    const out = area('', true); out.value = inv.code;
    const back = area('Paste here the code they send back');
    const st = h('p', { class: 'hint', text: '1. Send this code to the person (any chat). 2. They open Kraken, PROJECT > Play together > JOIN, paste it, and send you their code. 3. Paste their code below.' });
    body.replaceChildren(h('b', { class: 'collab-step', text: 'YOUR INVITATION' }), out, copy(out), h('b', { class: 'collab-step', text: 'THEIR CODE' }), back,
      h('div', { class: 'row', style: { display: 'flex', gap: '8px' } }, h('button', { class: 'add go', onclick: async () => {
        try { await inv.accept(back.value); st.textContent = 'Linking…'; } catch (e) { st.textContent = e.message; }
      } }, 'LINK'), h('button', { class: 'add', onclick: () => { inv.cancel(); home(); } }, 'BACK')), st);
  };
  const join = () => {
    const inp = area('Paste the invitation code here');
    const st = h('p', { class: 'hint' });
    body.replaceChildren(h('b', { class: 'collab-step', text: 'THE INVITATION' }), inp,
      h('div', { class: 'row', style: { display: 'flex', gap: '8px' } }, h('button', { class: 'add go', onclick: async () => {
        st.textContent = 'Answering…';
        try {
          const ans = await c.join(inp.value), out = area('', true); out.value = ans;
          body.replaceChildren(h('b', { class: 'collab-step', text: 'YOUR CODE: SEND IT BACK' }), out, copy(out),
            h('p', { class: 'hint', text: 'Send this code to the person who invited you. As soon as they paste it, you are linked and their song opens here (yours stays one Ctrl+Z away).' }));
        } catch (e) { st.textContent = e.message; }
      } }, 'ANSWER'), h('button', { class: 'add', onclick: home }, 'BACK')), st);
  };
  home();
  const m = app.modal('Play together', [body], [['Close', null, true]]);
  m.box.classList.add('collab-dlg');
  c.onChange = () => { collabMarks(app); if (m.box.isConnected && body.querySelector('.collab-people, .hint') && !body.querySelector('textarea')) home(); };
}

// the others' marks: who is on which track; the LIVE badge
export function collabMarks(app) {
  const c = app.collab, where = c.where();
  for (const el of document.querySelectorAll('.head[data-id]')) {
    const ps = where.get(el.dataset.id);
    el.style.boxShadow = ps ? `inset -3px 0 0 ${ps[0].color}` : '';
    el.title = ps ? `${ps.map((x) => x.name).join(', ')} ${ps.length > 1 ? 'are' : 'is'} here` : '';
  }
  const b = document.getElementById('livebadge');
  if (b) { const n = c.open.length; b.hidden = !n; b.textContent = `LIVE · ${n + 1}`; b.title = [c.me, ...c.open].map((x) => x.name).join(', '); }
}
