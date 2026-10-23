// SPDX-License-Identifier: GPL-3.0-only
// "Report a problem": what the person saw, in their words, with what Kraken knows (version, this device, the errors
// and the last actions), and their project if they want: shared to an email (a phone's share sheet, with the file),
// or a file to attach to an email that opens ready to send. Nothing leaves the device unless the person sends it.
import { h } from './kit.js';
import { diagnose, diagnosisText } from './diagnostic.js';
import { APP_VERSION } from '../project.js';
import { zip, saveFile } from '../io.js';

export const REPORT_TO = 'sodwavecontact@gmail.com';

export function reportText(app, words, rows) {
  const lines = [`KRAKEN PROBLEM REPORT · ${new Date().toISOString()}`, '', 'WHAT HAPPENED', words.trim() || '(not described)', '',
    'THIS DEVICE', diagnosisText(rows), '',
    `THE PROJECT · ${app.store.p.name} · ${app.store.p.tracks.length} tracks · ${app.store.p.bpm} BPM`, ''];
  if (app.errors.length) {
    lines.push('ERRORS');
    for (const e of app.errors.slice(-10)) lines.push(`${new Date(e.t).toLocaleTimeString()} ${e.msg}`, ...(e.stack ? [e.stack.split('\n').slice(0, 5).map((x) => '    ' + x.trim()).join('\n')] : []));
    lines.push('');
  }
  if (app.actions?.length) lines.push('LAST ACTIONS', app.actions.slice(-30).map((a) => `${new Date(a.t).toLocaleTimeString()} ${a.what}`).join('\n'), '');
  return lines.join('\n');
}

export async function reportDialog(app, { modal, toast }) {
  const words = h('textarea', { rows: 5, placeholder: 'What did you do, what happened, what did you expect? (in any language)', 'aria-label': 'What happened',
    style: { width: '100%', boxSizing: 'border-box', resize: 'vertical' }, onkeydown: (e) => e.stopPropagation() });
  const withProject = h('input', { type: 'checkbox', id: 'rep-proj' });
  const body = [
    h('p', { class: 'hint', text: `Kraken is in beta: every report makes it better. It goes to ${REPORT_TO}, with this device's details and the last errors; nothing is sent unless you send it.` }),
    words,
    h('label', { class: 'rep-check', for: 'rep-proj' }, withProject, h('span', { text: 'Include my project (notes and settings, not the audio files): it helps a lot to find the problem' })),
  ];
  const build = async () => {
    const rows = await diagnose(app);
    const text = reportText(app, words.value, rows);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const files = [{ name: 'report.txt', data: text }];
    if (withProject.checked) files.push({ name: 'project.kraken.json', data: JSON.stringify({ ...app.store.p, savedWith: APP_VERSION }, null, 1) });
    return { text, name: `kraken-report-${stamp}.zip`, data: zip(files), first: words.value.trim().split('\n')[0].slice(0, 60) };
  };
  const subject = (r) => `Kraken ${APP_VERSION}: ${r.first || 'a problem'}`;
  const send = async () => {
    const r = await build();
    const file = typeof File === 'function' ? new File([r.data], r.name, { type: 'application/zip' }) : null;
    if (file && navigator.canShare?.({ files: [file] })) {                   // a phone: the share sheet, the file attached
      try { await navigator.share({ files: [file], title: subject(r), text: `To: ${REPORT_TO}\n\n${r.text.slice(0, 1500)}` }); toast('Thank you! Choose your mail app and send it to ' + REPORT_TO + '.'); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    await saveFile(r.name, r.data);
    const mail = `mailto:${REPORT_TO}?subject=${encodeURIComponent(subject(r))}&body=${encodeURIComponent(`${words.value.trim() || '(describe the problem here)'}\n\n— Please attach the file ${r.name} (just downloaded) —\n\n${r.text.split('\nERRORS')[0].slice(0, 1200)}`)}`;
    window.open(mail, '_blank') || (location.href = mail);
    toast(`${r.name} downloaded: attach it to the email that opened (to ${REPORT_TO}). Thank you!`);
  };
  const copy = async () => {
    const r = await build();
    try { await navigator.clipboard.writeText(r.text); toast(`Report copied: paste it in an email to ${REPORT_TO}.`); } catch { toast('Could not copy here: use SEND instead.'); }
  };
  const m = modal('Report a problem', body, [['Copy the text', copy], ['Cancel'], ['Send…', send, true]]);
  setTimeout(() => words.focus(), 50);
  return m;
}
