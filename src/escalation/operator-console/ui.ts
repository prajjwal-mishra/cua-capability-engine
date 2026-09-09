/**
 * The operator desk.
 *
 * Still one page and no build step - the brief puts a full co-browsing product
 * out of scope. What changed is the chrome. A handoff is a control-room event:
 * the lease, the live viewport, and the reason we stopped should read that way
 * at a glance, not as a debug form that happens to have buttons.
 */

import type { Intervention } from "../intervention.js";
import { deskPage, esc } from "../../desk/chrome.js";

const LEASE_LABEL: Record<string, string> = {
  automation: "automation is driving",
  awaiting_operator: "waiting for you",
  operator: "you have the session",
};

/* ------------------------------------------------------------- queue ----- */

export function queueView(items: readonly Intervention[], hasLive: boolean): string {
  const open = items.filter((i) => i.status === "open" || i.status === "operator_control");
  const cards =
    items.length === 0
      ? `<div class="panel"><p class="empty">The queue is quiet.</p></div>`
      : `<div class="grid-cards">${items
          .map(
            (i) => `<a class="card" href="/i/${esc(i.interventionId)}">
        <div class="kicker">${esc(i.capability)} · ${esc(i.stepId)}</div>
        <h3>${esc(i.stepIntent)}</h3>
        <p>${esc(i.reason)}</p>
        <div class="foot">
          <span class="badge ${esc(i.classification === "policy_denied" ? "irreversible" : "awaiting_operator")}">${esc(i.classification)}</span>
          <span class="badge ${esc(i.status === "resolved" ? "approved" : i.status === "open" ? "awaiting_operator" : "operator")}">${esc(i.status.replace("_", " "))}</span>
        </div>
      </a>`,
          )
          .join("")}</div>`;

  const liveNote = hasLive
    ? `<p>A paused run is attached to this desk. Open the live intervention to take the session.</p>`
    : `<p>This desk is standalone: you can review every request a run has raised, but you cannot take a browser from here. Same-session takeover happens when a replay escalates with <code>--attended</code>.</p>`;

  return deskPage({
    title: "Cue · The Desk",
    face: "The Desk",
    liveBadge: hasLive ? "live session attached" : "no live session",
    liveClass: hasLive ? "operator" : "none",
    body: `<div class="wrap">
      <div class="hero">
        <div>
          <h1>Interventions.</h1>
          ${liveNote}
        </div>
        <div class="meta">${open.length} open · ${items.length} total</div>
      </div>
      ${cards}
    </div>`,
  });
}

/* ------------------------------------------------------- intervention ---- */

export function interventionView(i: Intervention, live: boolean, hasShot = false): string {
  const resumeOptions = [
    ...i.flow.map(
      (s) =>
        `<option value="${esc(s.id)}"${s.id === i.stepId ? " selected" : ""}>${esc(s.id)} - ${esc(s.intent)}${s.risk === "irreversible" ? "  · irreversible" : ""}</option>`,
    ),
    `<option value="$verify">$verify - I finished the flow; just verify</option>`,
  ].join("");

  const flow = `<ol class="flow">${i.flow
    .map(
      (s) => `<li class="${s.id === i.stepId ? "here" : ""}">
        <span class="sid">${esc(s.id)}</span>
        <span>${esc(s.intent)} <span class="risk">${esc(s.risk.replace("_", " "))}</span></span>
      </li>`,
    )
    .join("")}</ol>`;

  const controls = live
    ? `
      <h2>Take the session</h2>
      <div class="row">
        <button id="take" class="primary">Take control</button>
      </div>
      <div class="row">
        <label class="field" style="flex:1">Page element
          <select id="ref"><option value="">- take control to load elements -</option></select>
        </label>
      </div>
      <div class="row">
        <input type="text" id="text" placeholder="text to type" style="flex:1">
        <button id="doType" disabled>Type</button>
        <button id="doClick" disabled>Click</button>
      </div>
      <p class="note">If the browser is headed, drive the visible window - every action is captured either way. These controls exist so takeover is equally real when it is headless.</p>
      <h2 style="margin-top:22px">What you did</h2>
      <ul class="log" id="log"><li>Nothing captured yet.</li></ul>
      <h2 style="margin-top:22px">Hand it back</h2>
      <div class="row">
        <label class="field" style="flex:1">Resume at
          <select id="resumeAt">${resumeOptions}</select>
        </label>
      </div>
      <div class="row">
        <input type="text" id="note" placeholder="what you did, for the run record" style="flex:1">
        <button id="hand" class="warn" disabled>Hand back &amp; resume</button>
      </div>
      <p class="note">Automation re-observes the live page and re-checks that step's precondition before it acts. Your answer tells it where to look, not what to believe.</p>`
    : `<p class="note">No live session is attached, so control cannot be transferred here. The request is preserved with its full context.</p>`;

  return deskPage({
    title: `Cue · ${i.interventionId}`,
    face: "The Desk",
    liveBadge: live ? LEASE_LABEL.awaiting_operator : i.status,
    liveClass: live ? "awaiting_operator" : i.status === "resolved" ? "approved" : "none",
    script: live ? CLIENT_JS : undefined,
    body: `<div class="wrap">
      <div class="hero">
        <div>
          <h1>${esc(i.stepId)} stopped.</h1>
          <p>${esc(i.capability)} · ${esc(i.runId)}</p>
        </div>
      </div>
      <div class="grid-2">
        <section class="panel">
          <h2>Why the run stopped</h2>
          <dl class="kv">
            <dt>goal</dt><dd>${esc(i.goal)}</dd>
            <dt>step</dt><dd>${esc(i.stepId)} - ${esc(i.stepIntent)}</dd>
            <dt>class</dt><dd>${esc(i.classification)}</dd>
            <dt>status</dt><dd id="status">${esc(i.status)}</dd>
          </dl>
          <div class="reason">${esc(i.reason)}</div>
          ${i.visibleText ? `<p class="note" style="margin-top:14px">${esc(i.visibleText)}</p>` : ""}
          <h2 style="margin-top:22px">The flow</h2>
          ${flow}
          ${controls}
        </section>
        <section class="panel">
          <h2>Live viewport</h2>
          <div class="viewport">
            <div class="bezel"><span>session</span><span id="shotnote">${live ? "polling every 1.5s · sensitive regions masked" : "captured when the run stopped"}</span></div>
            ${
              live
                ? `<img class="screen" id="shot" alt="live session" src="/api/live/screenshot">`
                : hasShot
                  ? `<img class="screen" id="shot" alt="session at stop" src="/i/${esc(i.interventionId)}/shot">`
                  : `<div class="screen empty-frame">no frame on disk - the run record still holds the snapshot</div>`
            }
          </div>
        </section>
      </div>
    </div>`,
  });
}

const CLIENT_JS = `
const $ = (id) => document.getElementById(id);
const LEASE = {
  automation: "automation is driving",
  awaiting_operator: "waiting for you",
  operator: "you have the session",
};
let controlled = false;

async function poll() {
  const shot = $("shot");
  if (shot) shot.src = "/api/live/screenshot?t=" + Date.now();
  try {
    const s = await (await fetch("/api/live/state")).json();
    const badge = $("lease");
    badge.textContent = LEASE[s.leaseOwner] || s.leaseOwner;
    badge.className = "badge " + s.leaseOwner;
    $("status").textContent = s.status;
    if (s.captured && s.captured.length) {
      $("log").innerHTML = s.captured
        .map((c) => "<li><b>" + c.describe + "</b><br>" + (c.framePath.join(" › ") || "main") + "</li>")
        .join("");
    }
  } catch (e) { /* the run may have resumed and closed the desk */ }
}

async function loadElements() {
  const snap = await (await fetch("/api/live/snapshot")).json();
  const sel = $("ref");
  sel.innerHTML = snap.elements
    .map((e) => '<option value="' + e.ref + '">[' + e.role + '] ' + (e.name || "(unnamed)") + " - " + (e.framePath.join(">") || "main") + "</option>")
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
  $("shotnote").textContent = "handed back at " + body.resumeAtStepId + " · the run re-observes before continuing";
  $("status").textContent = body.status || "resolved";
};

async function act(kind) {
  const ref = $("ref").value;
  const r = await fetch("/api/live/act", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, ref, text: $("text").value }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    $("shotnote").textContent = body.error || ("action refused (" + r.status + ")");
    return;
  }
  await loadElements();
  poll();
}
$("doClick").onclick = () => act("click");
$("doType").onclick = () => act("type");

poll();
setInterval(poll, 1500);
`;
