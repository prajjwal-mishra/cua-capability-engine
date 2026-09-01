/**
 * The agent-facing capability catalog.
 *
 * This is the seam the whole system exists to produce. Everything upstream —
 * the model, the snapshots, the compiler — is how a capability comes to exist.
 * This is how it gets used: an agent lists what is available, reads a typed
 * contract, and invokes one by name with typed arguments. It never learns that
 * there is a browser involved, and that is the point. The day a flow moves from
 * a legacy web app to a desktop app, this contract does not change.
 *
 * Deliberately NOT a general-purpose tool router. It answers three questions —
 * what exists, what does this one need, run it — because those are the three an
 * agent actually has.
 */

import { join } from "node:path";
import { toolContract, type CapabilityArtifact } from "../artifact/schema.js";
import { RISK_ORDER, type RiskClass } from "../policy/risk.js";
import { ArtifactStore } from "../artifact/store.js";
import { loadAllowlist } from "../policy/allowlist.js";
import { replayCapability, InputValidationError } from "../replay/executor.js";
import { openSession } from "../replay/session.js";
import type { ReplayResult } from "../replay/result.js";
import { compareVersions } from "../artifact/version.js";

/** What an agent sees when it lists the catalog: contract, not implementation. */
export interface CatalogEntry {
  readonly capabilityId: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly state: CapabilityArtifact["lifecycle"]["state"];
  /** The highest risk class any step in the flow carries. An agent needs this
   *  before it calls: a capability that can write is not one to call on a hunch. */
  readonly maxRisk: RiskClass;
  readonly appId: string;
  readonly vendorProduct: string;
  readonly stability: { runs: number; successes: number; rate: number | null };
  readonly tool: ReturnType<typeof toolContract>;
  /** The business outcomes a caller must be prepared to receive. */
  readonly outcomes: readonly { code: string; severity: string; message: string }[];
}

export class CapabilityNotInvocable extends Error {}

export function entryFor(artifact: CapabilityArtifact): CatalogEntry {
  const { runs, successes } = artifact.lifecycle.stability;
  return {
    capabilityId: artifact.capabilityId,
    version: artifact.version,
    name: artifact.name,
    description: artifact.description,
    state: artifact.lifecycle.state,
    maxRisk: maxRisk(artifact),
    appId: artifact.target.appId,
    vendorProduct: artifact.target.vendorProduct,
    stability: { runs, successes, rate: runs === 0 ? null : successes / runs },
    tool: toolContract(artifact),
    outcomes: artifact.knownOutcomes
      .filter((o) => o.severity === "business")
      .map((o) => ({ code: o.code, severity: o.severity, message: o.message })),
  };
}

export function maxRisk(artifact: CapabilityArtifact): RiskClass {
  return artifact.steps.reduce<RiskClass>(
    (worst, step) => (RISK_ORDER[step.risk] > RISK_ORDER[worst] ? step.risk : worst),
    "read_only",
  );
}

/** Latest version of each capability — an agent invokes by name, not by build. */
export function listCatalog(store = new ArtifactStore()): CatalogEntry[] {
  const newest = new Map<string, CapabilityArtifact>();
  for (const artifact of store.list()) {
    const held = newest.get(artifact.capabilityId);
    if (!held || compareVersions(artifact.version, held.version) > 0) {
      newest.set(artifact.capabilityId, artifact);
    }
  }
  return [...newest.values()]
    .map(entryFor)
    .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
}

export interface InvokeOptions {
  readonly tenant?: string;
  readonly allowWrites?: boolean;
  /** Permit calling a capability that has not been approved. Off by default:
   *  an unattended agent must not be the thing that decides an unreviewed
   *  recording is safe to run against a system of record. */
  readonly allowDraft?: boolean;
  readonly headless?: boolean;
}

/**
 * Invoke a capability by name with typed arguments.
 *
 * Returns the replay result contract unchanged — including `escalated`. That is
 * deliberate: an agent that asks for something needing human judgement should
 * be told a human was asked, with the intervention id, not be left holding a
 * timeout. It is a legitimate answer, and the console picks the request up
 * out of band.
 */
export async function invokeCapability(
  ref: string,
  args: Readonly<Record<string, unknown>>,
  options: InvokeOptions = {},
): Promise<ReplayResult> {
  const store = new ArtifactStore();
  const { artifact } = store.resolve(ref, options.tenant);

  if (artifact.lifecycle.state !== "approved" && options.allowDraft !== true) {
    throw new CapabilityNotInvocable(
      `${artifact.capabilityId}@${artifact.version} is '${artifact.lifecycle.state}', not approved. ` +
        `Approve it (cua catalog approve ${artifact.capabilityId}) or pass allowDraft to call it anyway.`,
    );
  }
  if (artifact.lifecycle.state === "deprecated") {
    throw new CapabilityNotInvocable(
      `${artifact.capabilityId}@${artifact.version} is deprecated and must not be invoked.`,
    );
  }

  const risk = maxRisk(artifact);
  if (risk !== "read_only" && options.allowWrites !== true) {
    throw new CapabilityNotInvocable(
      `${artifact.capabilityId} contains a '${risk}' step; the caller must explicitly opt into writes.`,
    );
  }

  const inputs = coerceArgs(artifact, args);
  const allowlist = loadAllowlist(join(process.cwd(), artifact.policy.allowlistRef));
  const session = await openSession({
    artifact,
    allowlist,
    allowWrites: options.allowWrites === true,
    label: "invoke",
    headless: options.headless,
  });

  try {
    const result = await replayCapability(
      artifact,
      session.surface,
      session.control,
      session.log,
      session.evidence,
      { inputs, allowWrites: options.allowWrites === true, tenant: options.tenant },
    );
    store.recordRun(
      `${artifact.capabilityId}@${artifact.version}`,
      result.status === "success",
    );
    return result;
  } finally {
    await session.close();
  }
}

/**
 * Agents send JSON, and the artifact's inputs are declared as JSON Schema, but
 * the replay engine binds strings — a form field takes text. Coercing here, at
 * the boundary, keeps that conversion in one visible place instead of letting
 * `String(x)` appear halfway down the executor.
 *
 * Unknown arguments are rejected rather than dropped: an agent passing
 * `member_id` when the contract says `memberId` has made a mistake it needs to
 * hear about, not a member lookup with no member.
 */
function coerceArgs(
  artifact: CapabilityArtifact,
  args: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const declared = new Set(artifact.inputs.map((i) => i.name));
  const unknown = Object.keys(args).filter((k) => !declared.has(k));
  if (unknown.length > 0) {
    throw new InputValidationError(
      `unknown argument(s) ${unknown.join(", ")} for ${artifact.capabilityId}; ` +
        `it accepts: ${[...declared].join(", ") || "none"}`,
    );
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") {
      throw new InputValidationError(
        `argument '${key}' must be a scalar; this capability binds inputs into UI controls`,
      );
    }
    out[key] = String(value);
  }
  return out;
}
