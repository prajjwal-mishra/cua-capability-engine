/**
 * Human face of the catalog. The JSON contract at /capabilities is the
 * load-bearing artifact; this page exists so a reviewer can see that contract
 * without curling it, and invoke a capability the way an agent would - by name,
 * with typed arguments, with no mention of a browser.
 */

import type { CatalogEntry } from "./catalog.js";
import { deskPage, esc } from "../desk/chrome.js";

export function catalogApp(): string {
  return deskPage({
    title: "Cue · Catalog",
    face: "Catalog",
    script: CATALOG_JS,
    body: `<div class="wrap">
      <div class="hero">
        <div>
          <h1>Capabilities.</h1>
          <p>Typed contracts an agent can call by name. The browser is an implementation detail the caller never sees.</p>
        </div>
        <div class="meta" id="count"></div>
      </div>
      <div id="list" class="grid-cards"></div>
      <div id="detail" hidden></div>
    </div>`,
  });
}

const CATALOG_JS = `
const $ = (id) => document.getElementById(id);

function badge(kind, text) {
  return '<span class="badge ' + kind + '">' + text + '</span>';
}

function riskClass(r) {
  return r === "irreversible" ? "irreversible" : r === "reversible_write" ? "reversible_write" : "read_only";
}

function rate(s) {
  if (s.rate === null) return "unproven";
  return Math.round(s.rate * 100) + "% of " + s.runs;
}

function schemaFields(schema) {
  const props = (schema && schema.properties) || {};
  const required = new Set(schema && schema.required || []);
  return Object.entries(props).map(([name, spec]) => ({
    name, required: required.has(name), spec: spec || {},
  }));
}

async function loadList() {
  const entries = await (await fetch("/capabilities")).json();
  $("count").textContent = entries.length + " published";
  $("list").innerHTML = entries.map((e) => \`
    <a class="card" href="#/c/\${encodeURIComponent(e.capabilityId)}">
      <div class="kicker">\${e.appId} · \${e.vendorProduct}</div>
      <h3>\${e.name}</h3>
      <p>\${e.description}</p>
      <div class="foot">
        \${badge(e.state, e.state)}
        \${badge(riskClass(e.maxRisk), e.maxRisk.replace("_", " "))}
        \${badge("none", rate(e.stability))}
      </div>
    </a>\`).join("");
}

function fieldInput(f) {
  const ph = f.spec.pattern ? "pattern " + f.spec.pattern : (f.spec.type || "string");
  return \`<label class="field">\${f.name}\${f.required ? " · required" : ""}
    <input type="text" data-arg="\${f.name}" placeholder="\${ph}">
  </label>\`;
}

async function loadDetail(id) {
  $("list").hidden = true;
  $("detail").hidden = false;
  $("detail").innerHTML = '<p class="note">Loading contract…</p>';
  const e = await (await fetch("/capabilities/" + encodeURIComponent(id))).json();
  if (e.error) {
    $("detail").innerHTML = '<div class="panel"><p class="reason">' + e.error + '</p></div>';
    return;
  }
  const inputs = schemaFields(e.tool.inputSchema);
  const outputs = schemaFields(e.tool.outputSchema);
  const outcomes = (e.outcomes || []).map((o) =>
    '<li><b>' + o.code + '</b> - ' + o.message + '</li>'
  ).join("") || "<li>none declared</li>";

  $("detail").innerHTML = \`
    <p class="note"><a href="#/">← catalog</a></p>
    <div class="hero">
      <div>
        <h1>\${e.name}</h1>
        <p>\${e.description}</p>
      </div>
      <div class="foot" style="display:flex;gap:8px;flex-wrap:wrap">
        \${badge(e.state, e.state)}
        \${badge(riskClass(e.maxRisk), e.maxRisk.replace("_", " "))}
      </div>
    </div>
    <div class="grid-2">
      <section class="panel">
        <h2>Contract</h2>
        <dl class="kv">
          <dt>id</dt><dd class="mono">\${e.capabilityId}@\${e.version}</dd>
          <dt>app</dt><dd>\${e.appId}</dd>
          <dt>product</dt><dd>\${e.vendorProduct}</dd>
          <dt>stability</dt><dd>\${rate(e.stability)}</dd>
          <dt>returns</dt><dd>\${outputs.map((f) => f.name).join(", ") || "none"}</dd>
        </dl>
        <h2 style="margin-top:22px">Business outcomes</h2>
        <ul class="log">\${outcomes}</ul>
      </section>
      <section class="panel">
        <h2>Invoke</h2>
        <p class="note" style="margin-top:0">Same POST an agent would make. Drafts are refused unless you opt in; writes are refused unless you opt in. That is the catalog, not this page.</p>
        <form id="invoke">
          \${inputs.map(fieldInput).join("") || "<p class='note'>No arguments.</p>"}
          <div class="row">
            <label class="field" style="flex:0 0 auto;flex-direction:row;align-items:center;gap:8px;text-transform:none;letter-spacing:0">
              <input type="checkbox" id="allowDraft"> allow draft
            </label>
            <label class="field" style="flex:0 0 auto;flex-direction:row;align-items:center;gap:8px;text-transform:none;letter-spacing:0">
              <input type="checkbox" id="allowWrites"> allow writes
            </label>
            <label class="field">tenant
              <input type="text" id="tenant" placeholder="optional">
            </label>
          </div>
          <div class="row">
            <button class="primary" type="submit">Invoke</button>
          </div>
        </form>
        <pre class="result" id="out" hidden></pre>
      </section>
    </div>\`;

  $("invoke").onsubmit = async (ev) => {
    ev.preventDefault();
    const args = {};
    for (const input of $("invoke").querySelectorAll("[data-arg]")) {
      if (input.value !== "") args[input.dataset.arg] = input.value;
    }
    const out = $("out");
    out.hidden = false;
    out.className = "result pulse";
    out.textContent = "running…";
    const body = {
      args,
      allowDraft: $("allowDraft").checked,
      allowWrites: $("allowWrites").checked,
    };
    const tenant = $("tenant").value.trim();
    if (tenant) body.tenant = tenant;
    const r = await fetch("/capabilities/" + encodeURIComponent(id) + "/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    out.className = "result " + (r.ok && json.status !== "failed" && json.status !== "rejected" ? "ok" : "bad");
    out.textContent = JSON.stringify(json, null, 2);
  };
}

function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const m = hash.match(/^\\/c\\/(.+)$/);
  if (m) return loadDetail(decodeURIComponent(m[1]));
  $("detail").hidden = true;
  $("list").hidden = false;
  return loadList();
}

window.addEventListener("hashchange", route);
route();
`;
