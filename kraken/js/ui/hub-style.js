// SPDX-License-Identifier: GPL-3.0-only
// The hub window's styles (ui/hub.js puts them in the page once): the chassis and its black screen, as everywhere in
// Kraken, with the tokens of index.html (--chassis, --screen, --accent…). Kept here so the hub stays one piece.
export const HUB_CSS = `
.hub-bg { position: fixed; inset: 0; z-index: 70; background: #0007; display: grid; padding: 18px; box-sizing: border-box; }
.hub-bg[hidden] { display: none; }
.hub { display: grid; grid-template-rows: auto auto minmax(0, 1fr); min-height: 0; max-width: 1280px; width: 100%; justify-self: center;
  background: var(--chassis); border-radius: 14px; box-shadow: 0 24px 80px #000a, 0 1px 0 #fff9 inset; overflow: hidden; color: var(--ink); }
.hub-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px 8px; flex-wrap: wrap; }
.hub-logo { display: flex; align-items: baseline; gap: 8px; margin-right: 4px; }
.hub-logo b { font: 400 20px/1 var(--f-lcd); letter-spacing: 0.04em; }
.hub-logo small { font: 700 8.5px/1.2 var(--f-ui); letter-spacing: 0.14em; color: var(--ink-2); text-transform: uppercase; max-width: 30ch; }
.hub-search { flex: 1 1 200px; min-width: 0; max-width: 420px; height: 34px; box-sizing: border-box; border-radius: var(--r); border: 1px solid var(--edge);
  background: var(--chassis-hi); padding: 0 12px; font: 500 13px/1 var(--f-ui); color: var(--ink); outline: none; }
.hub-search:focus { border-color: var(--accent); }
.hub-head .spacer { flex: 1; }
.hub-head .hub-lab { height: 34px; padding: 0 12px; font-weight: 800; letter-spacing: 0.1em; }
.hub-me { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px 0 6px; border-radius: var(--r); border: 1px solid var(--edge);
  background: linear-gradient(var(--chassis-hi), var(--chassis)); cursor: pointer; min-width: 0; }
.hub-me .who { display: grid; gap: 3px; min-width: 0; text-align: left; }
.hub-me .who b { font: 700 10.5px/1 var(--f-ui); letter-spacing: 0.06em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 16ch; }
.hub-me .xpbar { width: 96px; }
.hub-x { width: 34px; padding: 0; font-size: 16px; }
.hub-tabs { display: flex; gap: 4px; padding: 0 12px 10px; overflow-x: auto; scrollbar-width: none; }
.hub-tabs::-webkit-scrollbar { display: none; }
.hub-tabs .key { flex: none; }
.hub-tabs .key.mod { color: var(--rec); }
.hub-body { background: var(--screen); color: var(--text); overflow-y: auto; min-height: 0; padding: 16px; box-shadow: 0 1px 0 #0006 inset; overscroll-behavior: contain; }
.hub-body h2 { margin: 0 0 10px; font: 400 15px/1.2 var(--f-lcd); color: var(--text); }
.hub-body h4 { margin: 18px 0 8px; font: 700 9px/1 var(--f-ui); letter-spacing: 0.16em; text-transform: uppercase; color: var(--dim); }
.hub-body p { font: 500 12px/1.55 var(--f-ui); color: var(--dim); margin: 0 0 8px; max-width: 70ch; }
.hub-body a { color: var(--accent); }
.hub-filters { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
.hub-chip { height: 28px; padding: 0 11px; border-radius: 14px; border: 1px solid var(--line-2); background: var(--screen-3); color: var(--text);
  font: 700 9.5px/1 var(--f-ui); letter-spacing: 0.12em; text-transform: uppercase; display: inline-flex; align-items: center; gap: 6px; }
.hub-chip:hover { border-color: var(--accent); }
.hub-chip.on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.hub-filters select { height: 28px; border-radius: 14px; border: 1px solid var(--line-2); background: var(--screen-3); color: var(--text); padding: 0 8px;
  font: 600 10.5px/1 var(--f-ui); max-width: 170px; }
.hub-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(214px, 1fr)); gap: 12px; }
.hub-card { display: grid; grid-template-rows: auto 1fr; text-align: left; border-radius: 10px; border: 1px solid var(--line-2); background: var(--screen-2);
  color: var(--text); padding: 0; overflow: hidden; cursor: pointer; min-width: 0; transition: border-color .12s, transform .12s; }
.hub-card:hover, .hub-card:focus-visible { border-color: var(--accent); transform: translateY(-1px); }
.hub-thumb { position: relative; aspect-ratio: 16 / 9; background: var(--g, linear-gradient(135deg, #14323f, #0b0c0d)); display: grid; place-items: center; overflow: hidden; }
.hub-thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.hub-thumb .art { position: absolute; inset: 0; display: block; }
.hub-thumb .art svg { width: 100%; height: 100%; display: block; }
.hub-thumb .glyph { font: 400 38px/1 var(--f-ui); color: #ffffffcc; text-shadow: 0 2px 12px #0008; }
.hub-thumb .kind { position: absolute; left: 8px; top: 8px; padding: 4px 7px; border-radius: 4px; background: #000b; color: #fff; font: 700 8.5px/1 var(--f-ui); letter-spacing: 0.14em; text-transform: uppercase; }
.hub-thumb .yt { position: absolute; right: 8px; bottom: 8px; width: 30px; height: 21px; border-radius: 6px; background: #f00; display: grid; place-items: center; }
.hub-thumb .yt::after { content: ""; border-left: 9px solid #fff; border-top: 5.5px solid transparent; border-bottom: 5.5px solid transparent; margin-left: 2px; }
.hub-thumb .tag-private { position: absolute; right: 8px; top: 8px; padding: 4px 7px; border-radius: 4px; background: #0b0d10d9; border: 1px solid #ffffff2e; color: #fff; font: 700 9px/1 var(--f-ui); letter-spacing: 0.08em; }
.hub-private { display: grid; grid-template-columns: 1fr auto; gap: 4px 14px; align-items: center; margin-top: 12px; padding: 12px 14px; border-radius: 10px; border: 1px solid #ffffff24; background: #ffffff0a; }
.hub-private b { font: 700 12px/1.2 var(--f-ui); letter-spacing: 0.06em; color: var(--text); }
.hub-private span { grid-column: 1; font: 500 11.5px/1.45 var(--f-ui); color: var(--dim); }
.hub-private .hub-btn { grid-column: 2; grid-row: 1 / span 2; }
@media (max-width: 560px) { .hub-private { grid-template-columns: 1fr; } .hub-private .hub-btn { grid-column: 1; grid-row: auto; justify-self: start; } }
.hub-vis { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.hub-vis button { display: grid; gap: 3px; text-align: left; padding: 10px 12px; border-radius: 9px; border: 1px solid var(--line, #2a2e35); background: #ffffff06; color: var(--text); cursor: pointer; }
.hub-vis button b { font: 700 12.5px/1.2 var(--f-ui); }
.hub-vis button small { font: 500 10.5px/1.35 var(--f-ui); color: var(--dim); }
.hub-vis button.on { border-color: var(--accent); background: #ff5b1418; box-shadow: inset 0 0 0 1px var(--accent); }
.hub-vis button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hub-thumb .tag-hidden { position: absolute; right: 8px; top: 8px; padding: 4px 7px; border-radius: 4px; background: var(--rec); color: #fff; font: 700 8.5px/1 var(--f-ui); letter-spacing: 0.12em; }
.hub-card .txt { display: grid; gap: 6px; padding: 10px 11px 11px; align-content: start; min-width: 0; }
.hub-card .ttl { font: 700 13px/1.25 var(--f-ui); letter-spacing: 0.01em; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.hub-by { display: flex; align-items: center; gap: 6px; min-width: 0; font: 600 11px/1.2 var(--f-ui); color: var(--text); }
.hub-by .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hub-flag { font-size: 14px; line-height: 1; font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif; }
.hub-lv { flex: none; padding: 3px 5px; border-radius: 3px; background: var(--screen-3); border: 1px solid var(--line-2); color: var(--accent); font: 700 8px/1 var(--f-ui); letter-spacing: 0.1em; text-transform: uppercase; white-space: nowrap; }
.hub-stats { display: flex; gap: 10px; flex-wrap: wrap; font: 500 10.5px/1 var(--f-mono); color: var(--dim); }
.hub-stats .liked { color: var(--accent); }
.hub-meta { font: 600 9.5px/1.3 var(--f-ui); letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hub-empty { padding: 34px 12px; text-align: center; display: grid; gap: 10px; justify-items: center; }
.hub-empty p { margin: 0 auto; }
.hub-more { margin: 16px auto 0; display: block; }
.hub-busy { padding: 40px; text-align: center; font: 400 12px/1 var(--f-lcd); color: var(--dim); }
.hub-busy::after { content: ""; display: block; width: 26px; height: 26px; margin: 14px auto 0; border-radius: 50%; border: 3px solid var(--line-2); border-top-color: var(--accent); animation: hubspin .8s linear infinite; }
@keyframes hubspin { to { transform: rotate(360deg); } }
.hub-btn { height: 34px; padding: 0 14px; border-radius: var(--r); border: 1px solid var(--line-2); background: var(--screen-3); color: var(--text);
  font: 700 10px/1 var(--f-ui); letter-spacing: 0.12em; text-transform: uppercase; display: inline-flex; align-items: center; justify-content: center; gap: 7px; white-space: nowrap; }
.hub-btn:hover { border-color: var(--accent); color: var(--accent); }
a.hub-btn { text-decoration: none; }
.hub-btn.go { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.hub-btn.go:hover { filter: brightness(1.08); color: var(--accent-ink); }
.hub-btn.on { border-color: var(--accent); color: var(--accent); }
.hub-btn.danger:hover { border-color: var(--rec); color: var(--rec); }
.hub-btn[disabled] { opacity: .5; pointer-events: none; }
.hub-back { margin-bottom: 12px; }
.hub-item { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(260px, 1fr); gap: 22px; align-items: start; }
.hub-item .hero { border-radius: 10px; overflow: hidden; border: 1px solid var(--line-2); }
.hub-item .hero .hub-thumb .glyph { font-size: 64px; }
.hub-item a.hero { display: block; position: relative; }
.hub-play { position: absolute; inset: 0; display: grid; place-items: center; }
.hub-play i { width: 68px; height: 48px; border-radius: 12px; background: #f00e; display: grid; place-items: center; box-shadow: 0 6px 24px #0009; }
.hub-play i::after { content: ""; border-left: 20px solid #fff; border-top: 12px solid transparent; border-bottom: 12px solid transparent; margin-left: 4px; }
.hub-item h2 { font: 700 22px/1.2 var(--f-ui); letter-spacing: -0.005em; margin: 0 0 8px; word-break: break-word; }
.hub-item .desc { white-space: pre-wrap; font: 500 13px/1.6 var(--f-ui); color: var(--text); margin: 12px 0; word-break: break-word; user-select: text; -webkit-user-select: text; }
.hub-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0; }
.hub-actions .hub-btn { height: 38px; }
.hub-warn { border: 1px solid #ffc21a66; background: #ffc21a14; color: #ffd76a; border-radius: 8px; padding: 9px 11px; font: 500 11.5px/1.45 var(--f-ui); }
.hub-likedin { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin: -4px 0 10px !important; }
.hub-likedin .hub-flag { font-size: 17px; }
.hub:focus { outline: none; }
.hub-tags { display: flex; gap: 5px; flex-wrap: wrap; }
.hub-tags button { height: 22px; padding: 0 8px; border-radius: 11px; border: 1px solid var(--line-2); background: none; color: var(--dim); font: 600 10px/1 var(--f-ui); }
.hub-tags button:hover { color: var(--accent); border-color: var(--accent); }
.hub-creator { display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 10px; background: var(--screen-2); border: 1px solid var(--line-2); cursor: pointer; text-align: left; color: var(--text); width: 100%; }
.hub-creator:hover { border-color: var(--accent); }
.hub-avatar { flex: none; width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center; background: var(--g, var(--screen-3)); font: 700 17px/1 var(--f-ui); color: #fff; position: relative; }
.hub-avatar .hub-flag { position: absolute; right: -4px; bottom: -3px; font-size: 16px; }
.hub-avatar.big { width: 76px; height: 76px; font-size: 30px; }
.hub-avatar.big .hub-flag { font-size: 24px; }
.hub-creator .who { display: grid; gap: 5px; min-width: 0; flex: 1; }
.hub-creator .who b { font: 700 13px/1.2 var(--f-ui); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xpbar { height: 6px; border-radius: 3px; background: var(--line-2); overflow: hidden; }
.hub-me .xpbar { background: var(--chassis-lo); }
.xpbar i { display: block; height: 100%; width: calc(var(--v, 0) * 100%); background: linear-gradient(90deg, var(--accent), #ffb21a); border-radius: 3px; }
.hub-profile { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 16px; align-items: center; margin-bottom: 10px; }
.hub-profile h2 { font: 700 22px/1.2 var(--f-ui); margin: 0 0 6px; word-break: break-word; }
.hub-profile .lvl { display: grid; gap: 6px; max-width: 420px; }
.hub-profile .lvl span { font: 600 11px/1.3 var(--f-ui); color: var(--dim); }
.hub-profile .lvl b { color: var(--accent); }
.hub-numbers { display: flex; gap: 22px; flex-wrap: wrap; margin: 12px 0; }
.hub-numbers div { display: grid; gap: 3px; }
.hub-numbers b { font: 400 18px/1 var(--f-lcd); color: var(--text); }
.hub-numbers small { font: 700 8.5px/1 var(--f-ui); letter-spacing: 0.14em; text-transform: uppercase; color: var(--dim); }
.hub-badges { display: flex; gap: 8px; flex-wrap: wrap; }
.hub-badge { display: flex; gap: 8px; align-items: center; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line-2); background: var(--screen-2); }
.hub-badge i { font-style: normal; font-size: 16px; }
.hub-badge b { font: 700 10.5px/1.2 var(--f-ui); display: block; }
.hub-badge small { font: 500 10px/1.2 var(--f-ui); color: var(--dim); }
.hub-badge.off { opacity: .38; filter: grayscale(1); }
.hub-howxp { text-align: left; border: 1px solid var(--line-2); border-radius: 10px; padding: 4px 12px; background: var(--screen-2); margin-top: 14px; }
.hub-howxp summary { cursor: pointer; padding: 8px 0; font: 700 10px/1 var(--f-ui); letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); }
.hub-howxp ul { margin: 4px 0 12px; padding-left: 18px; display: grid; gap: 5px; font: 500 12px/1.45 var(--f-ui); color: var(--text); }
.hub-levels { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px; margin: 0 0 12px; }
.hub-levels div { display: flex; justify-content: space-between; gap: 8px; padding: 6px 9px; border-radius: 6px; background: var(--screen-3); font: 600 11px/1.2 var(--f-ui); }
.hub-levels div.me { outline: 1px solid var(--accent); }
.hub-levels small { font: 500 10px/1.2 var(--f-mono); color: var(--dim); }
.hub-world { display: grid; gap: 6px; max-width: 760px; }
.hub-world button { display: grid; grid-template-columns: 30px 28px minmax(0, 1fr) repeat(3, minmax(62px, auto)); gap: 10px; align-items: center; text-align: left;
  padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line-2); background: var(--screen-2); color: var(--text); }
.hub-world button:hover { border-color: var(--accent); }
.hub-world .rank { font: 400 12px/1 var(--f-lcd); color: var(--dim); }
.hub-world .hub-flag { font-size: 22px; }
.hub-world .cn { font: 700 12.5px/1.2 var(--f-ui); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hub-world .num { display: grid; gap: 2px; justify-items: end; font: 400 13px/1 var(--f-lcd); }
.hub-world .num small { font: 700 7.5px/1 var(--f-ui); letter-spacing: 0.14em; color: var(--dim); text-transform: uppercase; }
.hub-totals { display: flex; gap: 22px; flex-wrap: wrap; margin: 0 0 16px; }
.hub-live { display: inline-flex; align-items: center; gap: 4px; margin-top: 14px; padding: 7px 12px; border-radius: 18px; border: 1px solid var(--line-2); background: #ffffff08; color: var(--text); font: 500 12.5px/1 var(--f-ui); cursor: pointer; }
.hub-live:hover { border-color: var(--accent); }
.hub-live[hidden] { display: none; }
.hub-live i { width: 8px; height: 8px; border-radius: 50%; background: var(--go); box-shadow: 0 0 0 3px #19b76533; margin-right: 4px; }
.hub-live b { font-weight: 800; }
.hub-people { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
.hub-person { position: relative; display: grid; justify-items: center; gap: 6px; padding: 16px 10px 12px; border-radius: 12px; border: 1px solid var(--line-2); background: var(--screen-2); color: var(--text); cursor: pointer; text-align: center; min-width: 0; transition: border-color .12s, transform .12s; }
.hub-person:hover, .hub-person:focus-visible { border-color: var(--accent); transform: translateY(-2px); }
.hub-person > b { font: 700 13.5px/1.2 var(--f-ui); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hub-person > small { font: 500 11px/1.3 var(--f-ui); color: var(--dim); }
.hub-person > small b { color: var(--text); font-weight: 700; }
.hub-person .hub-by { justify-content: center; }
.hub-new { position: absolute; top: 8px; right: 8px; padding: 3px 6px; border-radius: 4px; background: var(--go); color: #04170c; font: 800 8.5px/1 var(--f-ui); letter-spacing: 0.1em; text-transform: uppercase; }
.hub-form { display: grid; gap: 10px; max-width: 460px; }
.hub-form label, .hub-field, .modal .hub-field { display: grid; align-items: stretch; gap: 5px; font: 700 9px/1 var(--f-ui); letter-spacing: 0.14em; text-transform: uppercase; color: var(--dim); }
.hub-form input, .hub-form select, .hub-form textarea, .hub-field input, .hub-field select, .hub-field textarea { background: var(--screen-3); color: var(--text); border: 1px solid var(--line-2); border-radius: 6px;
  font: 500 13px/1.3 var(--f-ui); padding: 9px; box-sizing: border-box; width: 100%; letter-spacing: 0; text-transform: none; user-select: text; -webkit-user-select: text; }
.hub-form input:focus, .hub-field input:focus, .hub-field textarea:focus, .hub-field select:focus { outline: none; border-color: var(--accent); }
.hub-field textarea { resize: vertical; min-height: 64px; }
.hub-field .ok { color: var(--go); font: 600 10.5px/1.3 var(--f-ui); letter-spacing: 0; text-transform: none; }
.hub-field .bad { color: #ff7a5c; font: 600 10.5px/1.3 var(--f-ui); letter-spacing: 0; text-transform: none; }
.hub-login { max-width: 520px; margin: 10px auto; display: grid; gap: 12px; text-align: center; justify-items: center; }
.hub-login .hub-form { width: 100%; text-align: left; }
.hub-login .big { font-size: 46px; }
.hub-codebox { display: grid; gap: 8px; margin-top: 10px; text-align: left; }
.hub-wait { margin: 0 !important; font: 500 12px/1.45 var(--f-ui); color: var(--dim); }
.hub-coderow { display: flex; gap: 8px; }
.hub-code { flex: 1; min-width: 0; height: 40px; box-sizing: border-box; border-radius: 8px; border: 1px solid var(--line-2); background: var(--screen-3); color: var(--text);
  font: 600 20px/1 var(--f-mono); letter-spacing: 0.2em; text-align: center; padding: 0 8px; user-select: text; -webkit-user-select: text; }
.hub-code:focus { outline: none; border-color: var(--accent); }
.hub-sent { border: 1px solid #19b76566; background: #19b76514; color: #8be6b4; border-radius: 8px; padding: 10px 12px; font: 500 12px/1.5 var(--f-ui); }
.hub-mod { display: grid; gap: 10px; }
.hub-mod-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; padding: 12px; border-radius: 10px; border: 1px solid var(--line-2); background: var(--screen-2); align-items: start; }
.hub-mod-row .hub-actions { margin: 0; justify-content: flex-end; }
.hub-mod-row .hub-actions .hub-btn { height: 30px; padding: 0 10px; }
.hub-mod-row ul { margin: 6px 0 0; padding-left: 16px; font: 500 11px/1.45 var(--f-ui); color: var(--dim); }
.hub-status { display: inline-block; padding: 3px 6px; border-radius: 3px; font: 700 8.5px/1 var(--f-ui); letter-spacing: 0.12em; background: var(--rec); color: #fff; margin-left: 6px; vertical-align: middle; }
.hub-status.vis { background: var(--go); }
.hub-off { max-width: 560px; margin: 30px auto; text-align: center; display: grid; gap: 12px; justify-items: center; }
.hub-off .big { font-size: 54px; }
.modal.hub-pub { width: min(560px, 100%); }
.hub-xp-preview { display: grid; gap: 4px; padding: 10px 12px; border-radius: 8px; background: #ff5b1414; border: 1px solid #ff5b1455; }
.hub-xp-preview b { font: 400 14px/1.2 var(--f-lcd); color: var(--accent); }
.hub-xp-preview span { font: 500 11px/1.4 var(--f-ui); color: var(--dim); }
.hub-listen.on { background: var(--go); border-color: var(--go); color: #fff; }
@media (max-width: 900px) {
  .hub-item { grid-template-columns: minmax(0, 1fr); }
  /* one column: the picture, then what it is and what to do with it, then the creator's other work */
  .hub-item > div:first-child { display: contents; }
  .hub-item .hero { order: 0; }
  .hub-item > div:last-child { order: 1; min-width: 0; }
  .hub-item > div:first-child > :not(.hero) { order: 2; }
}
@media (max-width: 700px), (max-height: 520px) and (pointer: coarse) {
  .hub-bg { padding: 0; }
  .hub { border-radius: 0; max-width: none; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
  .hub-head { padding: 8px 8px 6px; gap: 6px; }
  .hub-logo small, .hub-me .who { display: none; }
  .hub-me { padding: 0 6px; }
  .hub-search { order: 5; flex-basis: 100%; max-width: none; height: 38px; }
  .hub-tabs { padding: 0 8px 8px; }
  .hub-tabs .key { height: 34px; padding: 0 10px; font-size: 9.5px; }
  .hub-body { padding: 12px 10px; }
  .hub-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .hub-card .txt { padding: 8px; }
  .hub-card .ttl { font-size: 12px; }
  .hub-world button { grid-template-columns: 22px 24px minmax(0, 1fr) repeat(2, auto); gap: 6px; padding: 9px 8px; }
  .hub-world .num.likes { display: none; }
  .hub-profile { grid-template-columns: minmax(0, 1fr); justify-items: start; }
  .hub-mod-row { grid-template-columns: minmax(0, 1fr); }
  .hub-mod-row .hub-actions { justify-content: flex-start; }
  #hubbtn { display: none !important; }
}
`;
// (the presets' list: a ☁ beside each one, to publish it)
export const PRESET_ROW_CSS = '.preset-row { grid-template-columns: minmax(0, 1fr) auto 28px 28px 28px; }';
