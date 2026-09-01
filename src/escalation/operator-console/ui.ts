/**
 * The operator console's markup.
 *
 * Deliberately one page and no build step. The brief puts a full co-browsing
 * console out of scope, and the interesting part of a handoff is not the
 * chrome around it — it is that the lease is authoritative, the session is the
 * same one, and the human's actions are captured. Everything here exists to
 * exercise those three things.
 */

import type { Intervention } from "../intervention.js";

const STYLE = `
:root {
  --bg: #0f1216; --panel: #171c22; --line: #262d36; --ink: #e6edf3;
  --muted: #8b98a5; --accent: #4c8dff; --warn: #e3b341; --bad: #f85149; --ok: #3fb950;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-size: 13px; line-height: 1.55; }
header {
  display: flex; align-items: center; gap: 14px; padding: 14px 20px;
  border-bottom: 1px solid var(--line); background: var(--panel);
}
header h1 { font-size: 14px; margin: 0; font-weight: 600; letter-spacing: .02em; }
.badge { padding: 2px 9px; border-radius: 999px; font-size: 11px; border: 1px solid var(--line); }
.badge.automation { color: var(--accent); border-color: #24406e; background: #101a2b; }
.badge.awaiting_operator { color: var(--warn); border-color: #4d3f18; background: #221c0d; }
.badge.operator { color: var(--ok); border-color: #1c3d24; background: #0d1f13; }
.badge.none { color: var(--muted); }
main { display: grid; grid-template-columns: minmax(320px, 460px) 1fr; gap: 18px; padding: 18px 20px; align-items: start; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; } }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px 18px; }
.panel h2 { font-size: 12px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 600; }
dl { display: grid; grid-template-columns: 108px 1fr; gap: 6px 12px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; word-break: break-word; }
.reason { border-left: 2px solid var(--bad); padding: 8px 12px; background: #1c1416; border-radius: 0 6px 6px 0; margin-top: 12px; }
.screen { width: 100%; border: 1px solid var(--line); border-radius: 6px; background: #000; display: block; }
button {
  font: inherit; padding: 7px 14px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--line); background: #202832; color: var(--ink);
}
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: .4; cursor: not-allowed; }
button.primary { background: #1b3050; border-color: #2c5599; color: #cfe2ff; }
button.warn { background: #2a2312; border-color: #5a4a1c; color: #f2d585; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
select, input[type=text] {
  font: inherit; background: #0f1419; color: var(--ink);
  border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; min-width: 0;
}
select { max-width: 100%; }
.log { margin: 12px 0 0; padding: 0; list-style: none; max-height: 190px; overflow-y: auto; }
.log li { padding: 5px 0; border-bottom: 1px dashed var(--line); color: var(--muted); }
.log li b { color: var(--ink); font-weight: 500; }
.empty { color: var(--muted); padding: 20px 0; text-align: center; }
table.q { width: 100%; border-collapse: collapse; }
table.q th, table.q td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
table.q th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
a { color: var(--accent); }
.note { color: var(--muted); margin-top: 14px; font-size: 12px; }
code { background: #0f1419; padding: 1px 5px; border-radius: 4px; }
`;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${STYLE}</style></head>
<body>${body}</body></html>`;
}

/* ------------------------------------------------------------- queue ----- */

export function queueView(items: readonly Intervention[], hasLive: boolean): string {
  const rows =
    items.length === 0
      ? `<tr><td colspan="5" class="empty">No interventions raised.</td></tr>`
      : items
          .map(
            (i) => `<tr>
      <td><a href="/i/${esc(i.interventionId)}">${esc(i.interventionId)}</a></td>
      <td>${esc(i.capability)}</td>
      <td>${esc(i.stepId)} — ${esc(i.stepIntent)}</td>
      <td>${esc(i.classification)}</td>
      <td>${esc(i.status)}</td>
    </tr>`,
          )
          .join("");

  return page(
    "Operator console",
    `<header>
      <h1>Operator console</h1>
      <span class="badge ${hasLive ? "operator" : "none"}">${hasLive ? "live session attached" : "no live session"}</span>
    </header>
    <main style="grid-template-columns:1fr">
      <section class="panel">
        <h2>Intervention queue</h2>
        <table class="q">
          <tr><th>id</th><th>capability</th><th>stopped at</th><th>why</th><th>status</th></tr>
          ${rows}
        </table>
        ${hasLive ? "" : `<p class="note">This console is running standalone, so it can review and resolve queued requests but cannot take control of a browser. Same-session takeover requires the console attached to a paused run — that happens automatically when a replay escalates with <code>--console</code>.</p>`}
      </section>
    </main>`,
  );
}

/* ------------------------------------------------------- intervention ---- */

export function interventionView(i: Intervention, live: boolean): string {
  const resumeOptions = [
    ...i.flow.map(
      (s) =>
        `<option value="${esc(s.id)}"${s.id === i.stepId ? " selected" : ""}>${esc(s.id)} — ${esc(s.intent)}${s.risk === "irreversible" ? " [irreversible]" : ""}</option>`,
    ),
    `<option value="$verify">$verify — I finished the flow; just verify and extract</option>`,
  ].join("");

  const controls = live
    ? `
      <div class="row">
        <button id="take" class="primary">Take control</button>
      </div>
      <div class="row">
        <select id="ref"><option value="">— take control to load page elements —</option></select>
      </div>
      <div class="row">
        <input type="text" id="text" placeholder="text to type (for a textbox)" style="flex:1">
        <button id="doType" disabled>Type</button>
        <button id="doClick" disabled>Click</button>
      </div>
      <p class="note">If the browser is running headed you can simply drive the visible window — every action is captured either way. These controls exist so takeover is equally real when the browser is headless.</p>
      <h2 style="margin-top:18px">Captured operator actions</h2>
      <ul class="log" id="log"><li>Nothing captured yet.</li></ul>
      <h2 style="margin-top:18px">Hand control back</h2>
      <div class="row">
        <select id="resumeAt">${resumeOptions}</select>
      </div>
      <div class="row">
        <input type="text" id="note" placeholder="what you did, for the run record" style="flex:1">
        <button id="hand" class="warn" disabled>Hand back &amp; resume</button>
      </div>
      <p class="note">Whatever you pick, automation re-observes the live page and re-checks that step's precondition before it acts. Your answer tells it where to look, not what to believe.</p>`
    : `<p class="note">No live session is attached to this console, so control cannot be transferred here. The request below is preserved with its full context.</p>`;

  return page(
    `Intervention ${i.interventionId}`,
    `<header>
      <h1><a href="/">&larr;</a> Intervention ${esc(i.interventionId)}</h1>
      <span class="badge automation" id="lease">lease: …</span>
    </header>
    <main>
      <section class="panel">
        <h2>Why the run stopped</h2>
        <dl>
          <dt>capability</dt><dd>${esc(i.capability)}</dd>
          <dt>goal</dt><dd>${esc(i.goal)}</dd>
          <dt>step</dt><dd>${esc(i.stepId)} — ${esc(i.stepIntent)}</dd>
          <dt>classification</dt><dd>${esc(i.classification)}</dd>
          <dt>run</dt><dd>${esc(i.runId)}</dd>
          <dt>status</dt><dd id="status">${esc(i.status)}</dd>
        </dl>
        <div class="reason">${esc(i.reason)}</div>
        ${i.visibleText ? `<h2 style="margin-top:16px">What the automation could see</h2><div class="note">${esc(i.visibleText)}</div>` : ""}
        ${controls}
      </section>
      <section class="panel">
        <h2>Live session</h2>
        <img class="screen" id="shot" alt="live session"
             src="${live ? "/api/live/screenshot" : esc(i.screenshotPath ?? "")}">
        <p class="note" id="shotnote">${live ? "Polling the live browser every 1.5s. Sensitive regions are masked before the image is encoded." : "Screenshot captured when the run stopped."}</p>
      </section>
    </main>
    <script>${live ? CLIENT_JS : ""}</script>`,
  );
}

const CLIENT_JS = `
const $ = (id) => document.getElementById(id);
let controlled = false;

async function poll() {
  $("shot").src = "/api/live/screenshot?t=" + Date.now();
  try {
    const s = await (await fetch("/api/live/state")).json();
    const badge = $("lease");
    badge.textContent = {
      automation: "automation is driving",
      awaiting_operator: "waiting for you to take control",
      operator: "you are driving this session",
    }[s.leaseOwner] || s.leaseOwner;
    badge.className = "badge " + s.leaseOwner;
    $("status").textContent = s.status;
    if (s.captured && s.captured.length) {
      $("log").innerHTML = s.captured
        .map((c) => "<li><b>" + c.describe + "</b><br>" + (c.framePath.join(" &rsaquo; ") || "main") + "</li>")
        .join("");
    }
  } catch (e) { /* the run may have resumed and closed the console */ }
}

async function loadElements() {
  const snap = await (await fetch("/api/live/snapshot")).json();
  const sel = $("ref");
  sel.innerHTML = snap.elements
    .map((e) => '<option value="' + e.ref + '">[' + e.role + '] ' + (e.name || "(unnamed)") + " — " + (e.framePath.join(">") || "main") + "</option>")
    .join("");
}

$("take").onclick = async () => {
  await fetch("/api/live/take", { method: "POST" });
  controlled = true;
  $("take").disabled = true;
  $("hand").disabled = false;
  $("doType").disabled = false;
  $("doClick").disabled = false;
  await loadElements();
  poll();
};

$("hand").onclick = async () => {
  const r = await fetch("/api/live/handback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: $("note").value, resumeAtStepId: $("resumeAt").value }),
  });
  const body = await r.json();
  $("hand").disabled = true;
  $("doType").disabled = true;
  $("doClick").disabled = true;
  $("shotnote").textContent = "Control handed back at " + body.resumeAtStepId + ". The run re-observes and re-verifies that step's precondition before continuing — it never assumes the page is where it left it.";
  $("status").textContent = body.status || "resolved";
};

async function act(kind) {
  const ref = $("ref").value;
  await fetch("/api/live/act", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, ref, text: $("text").value }),
  });
  await loadElements();
  poll();
}
$("doClick").onclick = () => act("click");
$("doType").onclick = () => act("type");

poll();
setInterval(poll, 1500);
`;
