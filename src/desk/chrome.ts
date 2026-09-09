/**
 * Shared chrome for the two human-facing surfaces: the operator desk and the
 * capability catalog. One visual language so they read as the same product,
 * not two intern pages that happened to ship in the same repo.
 *
 * No build step. Fonts load from a public CDN with system fallbacks, so a
 * reviewer on a plane still gets a usable page.
 */

export const DESK_CSS = `
:root {
  --bg: #0c0a07;
  --bg-2: #14110c;
  --panel: #18140f;
  --panel-2: #1e1913;
  --line: #2c261c;
  --line-2: #3a3226;
  --ink: #f3ead8;
  --muted: #9a8d78;
  --faint: #6d6354;
  --copper: #c4783a;
  --copper-2: #e8b07a;
  --brass: #c4a574;
  --live: #7aab7a;
  --warn: #d4a84b;
  --bad: #d45a48;
  --ok: #7aab7a;
  --focus: #c4783a;
  --serif: "Cormorant Garamond", "Iowan Old Style", "Palatino Linotype", Palatino, serif;
  --sans: "Outfit", "Avenir Next", "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
  font-family: var(--sans);
  color-scheme: dark;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; min-height: 100%; }
body {
  background:
    radial-gradient(1200px 600px at 12% -10%, rgba(196,120,58,.09), transparent 55%),
    radial-gradient(900px 500px at 100% 0%, rgba(122,171,122,.05), transparent 50%),
    var(--bg);
  color: var(--ink);
  font-size: 14px;
  line-height: 1.5;
  letter-spacing: .01em;
}
a { color: var(--copper-2); text-decoration: none; }
a:hover { color: var(--ink); }
code, .mono { font-family: var(--mono); font-size: 12px; }

.top {
  display: flex; align-items: center; gap: 18px;
  padding: 16px 28px 14px;
  border-bottom: 1px solid var(--line);
  background: rgba(12,10,7,.78);
  backdrop-filter: blur(10px);
  position: sticky; top: 0; z-index: 20;
}
.brand {
  display: flex; align-items: baseline; gap: 10px;
  text-decoration: none; color: inherit;
}
.mark {
  width: 11px; height: 11px; background: var(--copper);
  display: inline-block; transform: translateY(1px);
}
.brand .word {
  font-family: var(--serif);
  font-size: 22px; font-weight: 500; letter-spacing: .08em;
  text-transform: uppercase;
}
.brand .sep { color: var(--faint); font-size: 18px; }
.brand .face {
  font-size: 11px; letter-spacing: .22em; text-transform: uppercase;
  color: var(--muted); font-weight: 500;
}
.top-spacer { flex: 1; }
.meta { color: var(--muted); font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }

.badge {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 5px 12px 5px 10px; border-radius: 999px;
  border: 1px solid var(--line); font-size: 11px;
  letter-spacing: .12em; text-transform: uppercase; font-weight: 500;
  color: var(--muted); background: var(--panel);
}
.badge::before {
  content: ""; width: 7px; height: 7px; border-radius: 50%;
  background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 18%, transparent);
}
.badge.automation { color: var(--brass); }
.badge.awaiting_operator { color: var(--warn); }
.badge.operator { color: var(--live); }
.badge.none { color: var(--faint); }
.badge.draft { color: var(--brass); }
.badge.approved { color: var(--live); }
.badge.deprecated { color: var(--bad); }
.badge.read_only { color: var(--muted); }
.badge.reversible_write { color: var(--warn); }
.badge.irreversible { color: var(--bad); }

.wrap { padding: 28px 28px 48px; max-width: 1440px; margin: 0 auto; }
.hero {
  display: flex; justify-content: space-between; align-items: flex-end;
  gap: 24px; margin-bottom: 28px;
}
.hero h1 {
  font-family: var(--serif); font-weight: 500;
  font-size: clamp(36px, 5vw, 56px); line-height: .95;
  margin: 0 0 8px; letter-spacing: -.02em;
}
.hero p { margin: 0; color: var(--muted); max-width: 42em; }

.grid-2 {
  display: grid; grid-template-columns: minmax(320px, 420px) 1fr;
  gap: 22px; align-items: start;
}
.grid-cards {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
}
@media (max-width: 960px) {
  .grid-2 { grid-template-columns: 1fr; }
  .wrap { padding: 20px 16px 40px; }
  .top { padding: 14px 16px; }
}

.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 2px;
  padding: 22px 22px 20px;
  position: relative;
}
.panel::before {
  content: ""; position: absolute; inset: 0 0 auto 0; height: 1px;
  background: linear-gradient(90deg, var(--copper), transparent 55%);
  opacity: .55;
}
.panel h2 {
  margin: 0 0 16px; font-size: 11px; font-weight: 500;
  letter-spacing: .18em; text-transform: uppercase; color: var(--muted);
}

dl.kv { display: grid; grid-template-columns: 108px 1fr; gap: 7px 14px; margin: 0; }
dt { color: var(--faint); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; padding-top: 3px; }
dd { margin: 0; word-break: break-word; }

.reason {
  margin-top: 16px; padding: 12px 14px;
  border-left: 2px solid var(--bad);
  background: color-mix(in srgb, var(--bad) 8%, var(--panel-2));
  color: var(--ink);
}

.viewport {
  background: #070605; border: 1px solid var(--line);
  padding: 10px; position: relative;
}
.viewport .bezel {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0 4px 8px; color: var(--faint);
  font-size: 10px; letter-spacing: .16em; text-transform: uppercase;
}
.screen {
  width: 100%; display: block; background: #000;
  border: 1px solid var(--line-2); min-height: 240px;
  image-rendering: auto;
}
.screen.empty-frame {
  min-height: 320px; display: grid; place-items: center;
  color: var(--faint); font-size: 11px; letter-spacing: .18em;
  text-transform: uppercase;
}

.flow { list-style: none; margin: 0; padding: 0; }
.flow li {
  display: grid; grid-template-columns: 42px 1fr; gap: 10px;
  padding: 9px 0; border-bottom: 1px solid var(--line);
  color: var(--muted);
}
.flow li:last-child { border-bottom: 0; }
.flow .sid { font-family: var(--mono); font-size: 11px; color: var(--faint); padding-top: 2px; }
.flow li.here { color: var(--ink); }
.flow li.here .sid { color: var(--copper-2); }
.flow .risk { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }

button, .btn {
  font-family: var(--sans); font-size: 13px; font-weight: 500;
  letter-spacing: .04em;
  padding: 9px 16px; border-radius: 1px; cursor: pointer;
  border: 1px solid var(--line-2); background: var(--panel-2); color: var(--ink);
}
button:hover:not(:disabled), .btn:hover { border-color: var(--copper); color: var(--copper-2); }
button:disabled { opacity: .38; cursor: not-allowed; }
button.primary {
  background: var(--copper); border-color: var(--copper); color: #1a1008;
}
button.primary:hover:not(:disabled) { background: var(--copper-2); border-color: var(--copper-2); color: #1a1008; }
button.warn {
  background: transparent; border-color: var(--warn); color: var(--warn);
}
button.warn:hover:not(:disabled) { background: var(--warn); color: #1a1008; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; }

select, input[type=text], input[type=search], textarea {
  font: inherit; font-size: 13px;
  background: #0e0c09; color: var(--ink);
  border: 1px solid var(--line-2); border-radius: 1px;
  padding: 9px 11px; min-width: 0;
}
select:focus, input:focus, textarea:focus, button:focus-visible {
  outline: 1px solid var(--copper); outline-offset: 1px;
}
select { max-width: 100%; }
label.field { display: flex; flex-direction: column; gap: 6px; font-size: 11px;
  letter-spacing: .12em; text-transform: uppercase; color: var(--muted); flex: 1; }

.log { margin: 12px 0 0; padding: 0; list-style: none; max-height: 210px; overflow-y: auto; }
.log li { padding: 8px 0; border-bottom: 1px dashed var(--line); color: var(--muted); font-size: 13px; }
.log li b { color: var(--ink); font-weight: 500; }

.note { color: var(--muted); margin-top: 14px; font-size: 13px; }
.empty { color: var(--faint); padding: 36px 8px; text-align: center; font-family: var(--serif); font-size: 22px; }

.card {
  display: block; background: var(--panel); border: 1px solid var(--line);
  padding: 22px 22px 18px; color: inherit; position: relative;
  min-height: 180px;
}
.card::before {
  content: ""; position: absolute; inset: 0 0 auto 0; height: 1px;
  background: var(--line-2);
}
.card:hover { border-color: var(--copper); }
.card:hover::before { background: var(--copper); }
.card .kicker {
  font-size: 10px; letter-spacing: .18em; text-transform: uppercase;
  color: var(--faint); margin-bottom: 10px;
}
.card h3 {
  font-family: var(--serif); font-size: 28px; font-weight: 500;
  margin: 0 0 10px; line-height: 1.05; letter-spacing: -.015em;
}
.card p { margin: 0 0 16px; color: var(--muted); font-size: 13px; }
.card .foot {
  display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
  margin-top: auto;
}

table.q { width: 100%; border-collapse: collapse; }
table.q th, table.q td { text-align: left; padding: 12px 10px; border-bottom: 1px solid var(--line); }
table.q th {
  color: var(--faint); font-weight: 500; font-size: 10px;
  letter-spacing: .16em; text-transform: uppercase;
}
table.q tr:hover td { background: color-mix(in srgb, var(--copper) 6%, transparent); }

.result {
  margin-top: 16px; padding: 14px 16px; border: 1px solid var(--line);
  background: #0e0c09; font-family: var(--mono); font-size: 12px;
  white-space: pre-wrap; max-height: 360px; overflow: auto;
}
.result.ok { border-color: color-mix(in srgb, var(--live) 45%, var(--line)); }
.result.bad { border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }

.pulse { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .45; } }
`;

const FONTS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=IBM+Plex+Mono:wght@400;500&family=Outfit:wght@400;500;600&display=swap" rel="stylesheet">
`;

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function deskPage(opts: {
  readonly title: string;
  readonly face: string;
  readonly body: string;
  readonly liveBadge?: string;
  readonly liveClass?: string;
  readonly script?: string;
}): string {
  const badge = opts.liveBadge
    ? `<span class="badge ${esc(opts.liveClass ?? "none")}" id="lease">${esc(opts.liveBadge)}</span>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(opts.title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${FONTS}
<style>${DESK_CSS}</style>
</head>
<body>
<header class="top">
  <a class="brand" href="/">
    <span class="mark"></span>
    <span class="word">Cue</span>
    <span class="sep">·</span>
    <span class="face">${esc(opts.face)}</span>
  </a>
  <span class="top-spacer"></span>
  ${badge}
</header>
${opts.body}
${opts.script ? `<script>${opts.script}</script>` : ""}
</body>
</html>`;
}
