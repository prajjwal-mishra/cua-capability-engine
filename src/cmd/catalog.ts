/**
 * `cua catalog` — what an AI agent sees.
 *
 * list / describe / invoke mirror the three questions a calling agent has, and
 * `approve` is the promotion gate between them: a recording is a draft until a
 * human says otherwise, and only approved capabilities are invocable
 * unattended. That gate is the cheapest real safety property in the system —
 * it costs one field and it is the difference between "the model found a way to
 * do this" and "we are willing to let this run against a member's account".
 */

import type { Args } from "../cli-args.js";
import { ArtifactStore } from "../artifact/store.js";
import { CapabilityArtifactSchema } from "../artifact/schema.js";
import {
  invokeCapability,
  listCatalog,
  entryFor,
  maxRisk,
  CapabilityNotInvocable,
} from "../catalog/catalog.js";
import { startCatalogServer } from "../catalog/server.js";
import { exitCodeFor, summarize, type ReplayResult } from "../replay/result.js";
import { describeOverlay } from "../artifact/overlays.js";

export async function catalogCommand(args: Args): Promise<void> {
  const sub = args.positional[0] ?? "list";
  switch (sub) {
    case "list":
      return list();
    case "describe":
      return describe(args);
    case "invoke":
      return invoke(args);
    case "approve":
      return setState(args, "approved");
    case "deprecate":
      return setState(args, "deprecated");
    case "serve":
      return serve(args);
    default:
      throw new Error(
        `unknown catalog subcommand '${sub}' — expected list | describe | invoke | approve | deprecate | serve`,
      );
  }
}

/* ----------------------------------------------------------------- list --- */

function list(): void {
  const entries = listCatalog();
  if (entries.length === 0) {
    console.log("no capabilities saved yet — run `cua discover` first");
    return;
  }
  console.log(`${entries.length} capability(ies):\n`);
  for (const e of entries) {
    const rate = e.stability.rate === null ? "unproven" : `${(e.stability.rate * 100).toFixed(0)}%`;
    console.log(`  ${e.capabilityId}@${e.version}  [${e.state}]  risk=${e.maxRisk}`);
    console.log(`    ${e.description}`);
    console.log(
      `    args: ${Object.keys(e.tool.inputSchema.properties as object).join(", ") || "none"}` +
        `   returns: ${Object.keys(e.tool.outputSchema.properties as object).join(", ") || "none"}` +
        `   stability: ${rate} of ${e.stability.runs}\n`,
    );
  }
  console.log(`describe one:  cua catalog describe ${entries[0]!.capabilityId}`);
}

/* ------------------------------------------------------------- describe --- */

function describe(args: Args): void {
  const ref = requireRef(args, "describe");
  const store = new ArtifactStore();
  const tenant = args.flags.tenant ? String(args.flags.tenant) : undefined;
  const { artifact, overlay } = store.resolve(ref, tenant);

  if (args.flags.json === true) {
    console.log(JSON.stringify(entryFor(artifact), null, 2));
    return;
  }

  const e = entryFor(artifact);
  console.log(`${e.capabilityId}@${e.version}   [${e.state}]`);
  console.log(`${e.description}\n`);
  console.log(`app:        ${e.appId} (${e.vendorProduct})${artifact.target.variant ? ` variant ${artifact.target.variant}` : ""}`);
  console.log(`entry:      ${artifact.target.entryPoint}`);
  console.log(`discovered: ${artifact.provenance.discoveredBy} on ${artifact.provenance.recordedAt}`);
  console.log(`risk:       ${maxRisk(artifact)} (highest of any step)`);

  if (overlay) {
    console.log(`\noverlay ${overlay.overlayId} for tenant ${overlay.tenant}:`);
    for (const line of describeOverlay(overlay)) console.log(`  ${line}`);
  }

  console.log(`\ninput contract (JSON Schema):`);
  console.log(indent(JSON.stringify(e.tool.inputSchema, null, 2)));
  console.log(`\noutput contract (JSON Schema):`);
  console.log(indent(JSON.stringify(e.tool.outputSchema, null, 2)));

  console.log(`\nsteps:`);
  for (const s of artifact.steps) {
    console.log(`  ${s.id}  ${s.action.padEnd(8)} ${s.risk.padEnd(17)} ${s.intent}`);
    if (s.target) {
      console.log(`        via ${s.target.strategies.map((st) => st.kind).join(" → ")}`);
    }
  }

  console.log(`\nbusiness outcomes a caller must handle:`);
  for (const o of e.outcomes) console.log(`  ${o.code.padEnd(22)} ${o.message}`);

  console.log(`\nconditions it recovers from on its own:`);
  for (const r of artifact.recoveries) {
    console.log(`  ${r.code.padEnd(22)} ${r.describe ?? ""} (max ${r.maxAttempts})`);
  }
}

/* --------------------------------------------------------------- invoke --- */

async function invoke(args: Args): Promise<void> {
  const ref = requireRef(args, "invoke");
  const raw = args.flags.args ? String(args.flags.args) : "{}";

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`--args must be JSON; got: ${raw}`);
  }
  // `--input k=v` is accepted too, so the same muscle memory works everywhere.
  const callArgs = { ...parsed, ...args.inputs };

  console.log(`invoking ${ref} with ${JSON.stringify(callArgs)}\n`);

  try {
    const result = await invokeCapability(ref, callArgs, {
      tenant: args.flags.tenant ? String(args.flags.tenant) : undefined,
      allowWrites: args.flags["allow-writes"] === true,
      allowDraft: args.flags["allow-draft"] === true,
    });
    // An agent consumes the JSON; the human running this reads the summary.
    console.log(JSON.stringify(agentView(result), null, 2));
    console.log(`\n${summarize(result)}`);
    process.exit(exitCodeFor(result));
  } catch (err) {
    if (err instanceof CapabilityNotInvocable) {
      console.log(JSON.stringify({ status: "rejected", reason: err.message }, null, 2));
      process.exit(40);
    }
    throw err;
  }
}

/**
 * What the calling agent gets. Evidence paths and per-step telemetry are for
 * operators debugging a run, not for a model deciding what to do next — handing
 * them to the agent invites it to reason about our internals.
 */
function agentView(result: ReplayResult): Record<string, unknown> {
  const base = { capability: result.capability, status: result.status };
  switch (result.status) {
    case "success":
      return { ...base, outputs: result.outputs };
    case "business_outcome":
      return { ...base, code: result.code, message: result.message, mapsTo: result.mapsTo };
    case "escalated":
      return { ...base, interventionId: result.interventionId, reason: result.reason };
    case "failed":
      return {
        ...base,
        error: {
          stepId: result.error.stepId,
          classification: result.error.classification,
          expected: result.error.expected,
          observed: result.error.observed,
        },
      };
  }
}

/* ------------------------------------------------------------ lifecycle --- */

function setState(args: Args, state: "approved" | "deprecated"): void {
  const ref = requireRef(args, state === "approved" ? "approve" : "deprecate");
  const store = new ArtifactStore();
  const artifact = store.load(ref);

  const { runs, successes } = artifact.lifecycle.stability;
  if (state === "approved" && runs === 0) {
    throw new Error(
      `${artifact.capabilityId}@${artifact.version} has never been replayed. Approve it only after a ` +
        `shadow replay proves it works: cua replay --capability ${artifact.capabilityId} --stability 5`,
    );
  }

  store.save(
    CapabilityArtifactSchema.parse({
      ...artifact,
      lifecycle: { ...artifact.lifecycle, state },
    }),
  );
  console.log(
    `${artifact.capabilityId}@${artifact.version}: ${artifact.lifecycle.state} → ${state}` +
      (state === "approved" ? `  (${successes}/${runs} replays succeeded)` : ""),
  );
}

/* --------------------------------------------------------------- serve ---- */

async function serve(args: Args): Promise<void> {
  const port = Number(args.flags.port ?? 4200);
  const server = await startCatalogServer(port);
  console.log(`capability catalog: ${server.url}/capabilities`);
  console.log(`invoke:             POST ${server.url}/capabilities/<id>/invoke`);
  console.log(`\nCtrl-C to stop.`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => void server.close().then(resolve));
  });
}

/* -------------------------------------------------------------- helpers --- */

function requireRef(args: Args, sub: string): string {
  const ref = args.positional[1] ?? (args.flags.capability ? String(args.flags.capability) : "");
  if (!ref) throw new Error(`catalog ${sub} needs a capability id`);
  return ref;
}

const indent = (s: string): string =>
  s
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
