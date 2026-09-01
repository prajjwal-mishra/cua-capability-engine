/**
 * Compilation: a discovery trace becomes a CapabilityArtifact.
 *
 * This step is deterministic and does not call the model. The model chose the
 * path; every mechanical fact in the artifact — descriptors, checkpoints,
 * routes, ordinals — is read out of the snapshots that were actually captured.
 * Re-running compilation on the same trace always produces the same artifact,
 * which is what makes the artifact reviewable rather than a second opinion.
 *
 * ON RECOVERIES. A single discovery run cannot be relied upon to encounter a
 * session timeout, a transient 503, and an interstitial. Synthesizing recoveries
 * for conditions we never saw would be fabricating capability. So recoveries and
 * known outcomes come from two places, both recorded in provenance: whatever the
 * run genuinely hit, plus a REVIEWED PACK authored per vendor product. That pack
 * is data, it is diffable, and attaching it is a human act — which is exactly
 * what promoting a draft to approved should mean.
 */

import { z } from "zod";
import { describeElement } from "../locator/descriptor.js";
import { classifyAction } from "../policy/risk.js";
import type { Allowlist } from "../policy/allowlist.js";
import type { UIElement, UISnapshot } from "../surface/types.js";
import {
  CapabilityArtifactSchema,
  ConditionSchema,
  ElementDescriptorSchema,
  KnownOutcomeSchema,
  RecoverySchema,
  SCHEMA_VERSION,
  type CapabilityArtifact,
  type Condition,
  type Step,
} from "../artifact/schema.js";
import type { DiscoveryTrace, RecordedStep } from "../discovery/loop.js";
import { evaluateCondition } from "../replay/checkpoint.js";
import {
  assertionFrame,
  canonicalizeEntryPoint,
  changedFrame,
  contentRoute,
  contentUrl,
  generalizeDetectorText,
  newlyPresent,
  parameterizeStrategyText,
  type ParamProvenance,
} from "./generalize.js";

/** A human-authored, reviewable set of conditions for one vendor product. */
export const RecoveryPackSchema = z.object({
  vendorProduct: z.string(),
  describe: z.string().optional(),
  knownOutcomes: z.array(KnownOutcomeSchema).default([]),
  recoveries: z.array(RecoverySchema).default([]),
});
export type RecoveryPack = z.infer<typeof RecoveryPackSchema>;

export interface CompileOptions {
  readonly capabilityId: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly vendorProduct: string;
  readonly appId: string;
  readonly allowlist: Allowlist;
  readonly allowlistRef: string;
  readonly inputSpecs: readonly {
    name: string;
    description: string;
    sensitivity: "public" | "internal" | "pii" | "secret";
    jsonSchema: Record<string, unknown>;
  }[];
  readonly paramValues: Readonly<Record<string, string>>;
  readonly recoveryPack?: RecoveryPack;
  readonly gitSha?: string;
  readonly evidenceRef?: string;
}

export class CompileError extends Error {}

/**
 * Separate the flow from the interruptions.
 *
 * A step whose PRE-snapshot already matched a declared recoverable condition
 * was the model reacting to that condition, not advancing the goal. Those steps
 * are dropped from the capability and named in provenance, so a reviewer can
 * see what the run hit and satisfy themselves it is covered by a recovery.
 */
function partitionRecoverySteps(
  steps: readonly RecordedStep[],
  pack: RecoveryPack | undefined,
): { kept: RecordedStep[]; dropped: string[] } {
  const recoverable = (pack?.knownOutcomes ?? []).filter((o) => o.severity === "recoverable");
  if (recoverable.length === 0) return { kept: [...steps], dropped: [] };

  const kept: RecordedStep[] = [];
  const dropped: string[] = [];

  for (const step of steps) {
    const hit = recoverable.find((o) => evaluateCondition(o.detector, step.preSnapshot).passed);
    if (hit) {
      dropped.push(`${hit.code}: "${step.rationale}"`);
      continue;
    }
    kept.push(step);
  }
  return { kept, dropped };
}

/**
 * Build a descriptor and validate it against the artifact schema in one step.
 * The locator module types its arrays readonly; the schema's inferred type is
 * mutable. Parsing here reconciles the two AND means a malformed ladder is
 * caught at compile time rather than at replay time.
 */
function descriptorFor(
  el: UIElement,
  intent: string,
  provenance: ParamProvenance,
  opts: { forExtraction?: boolean } = {},
): z.infer<typeof ElementDescriptorSchema> {
  const built = ElementDescriptorSchema.parse(
    describeElement(el, intent, { forExtraction: opts.forExtraction }),
  );
  // Anything whose text IS a parameter value becomes a binding, so a descriptor
  // that identifies "the row for member 10042" becomes "the row for the member
  // this invocation asked about".
  return {
    ...built,
    strategies: built.strategies.map((strategy) => {
      switch (strategy.kind) {
        case "role_name":
          return { ...strategy, name: parameterizeStrategyText(strategy.name, provenance) };
        case "label_anchor":
          return {
            ...strategy,
            labelText: parameterizeStrategyText(strategy.labelText, provenance),
          };
        case "table_cell":
          return {
            ...strategy,
            columnHeader: parameterizeStrategyText(strategy.columnHeader, provenance),
            rowKey: parameterizeStrategyText(strategy.rowKey, provenance),
          };
        case "frame_role_ordinal":
          return strategy.name === undefined
            ? strategy
            : { ...strategy, name: parameterizeStrategyText(strategy.name, provenance) };
        default:
          return strategy;
      }
    }),
  };
}

export function compileTrace(trace: DiscoveryTrace, opts: CompileOptions): CapabilityArtifact {
  if (trace.status !== "success") {
    throw new CompileError(
      `refusing to compile a capability from a run that ended '${trace.status}': ${trace.stopReason}`,
    );
  }
  if (trace.steps.length === 0) throw new CompileError("trace contains no steps");

  const provenance: ParamProvenance = {
    values: opts.paramValues,
    bound: new Set(trace.steps.map((s) => s.paramBinding).filter((x): x is string => Boolean(x))),
  };

  // Drop the actions the model took purely to clear a declared exceptional
  // state. During discovery the app may throw an interstitial or a timeout at
  // any moment; the model deals with it and moves on, but that click is NOT
  // part of the flow. Recording it makes the interstitial mandatory — the next
  // replay looks for an "Acknowledge" button that is not there, degrades down
  // the ladder, and clicks whatever else happens to be the first button on the
  // page. The condition is already declared in the reviewed pack, with a
  // recovery; that is where it belongs.
  const { kept, dropped } = partitionRecoverySteps(trace.steps, opts.recoveryPack);

  const steps = kept.map((recorded, i) => compileStep(recorded, i, opts.allowlist, provenance));

  // The entry point is the route of the frame the flow first touches — not
  // whichever frame happens to be deepest, which in a shell app is a coin flip
  // between the menu and the content.
  const first = kept[0]!;
  const entryPoint = canonicalizeEntryPoint(
    contentUrl(first.preSnapshot, first.element?.framePath),
    provenance,
  );

  const outputs = trace.outputs.map((o) => ({
    name: o.name,
    jsonSchema: { type: "string" as const },
    required: true,
    sensitivity: "internal" as const,
    extraction: {
      descriptor: descriptorFor(o.element, `the ${o.name.replace(/_/g, " ")} value`, provenance, {
        forExtraction: true,
      }),
      parse: o.parse === "currency" ? ({ kind: "currency" } as const) : ({ kind: "text" } as const),
    },
  }));

  const discoveredOutcomes = trace.outcomes.map((o) => {
    const { text } = generalizeDetectorText(o.evidenceText, provenance);
    return KnownOutcomeSchema.parse({
      code: o.code,
      severity: o.severity,
      message: o.message,
      detector: {
        all: [{ type: "textPresent", text, framePath: assertionFrame(o.snapshot) }],
        describe: `the screen shows "${text}"`,
      },
    });
  });

  const pack = opts.recoveryPack;
  const knownOutcomes = dedupeByCode([...discoveredOutcomes, ...(pack?.knownOutcomes ?? [])]);

  return CapabilityArtifactSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    capabilityId: opts.capabilityId,
    version: opts.version,
    name: opts.name,
    description: opts.description,
    provenance: {
      discoveredBy: trace.model,
      runId: trace.runId,
      recordedAt: new Date().toISOString(),
      gitSha: opts.gitSha,
      surfaceType: "legacy-web",
      evidenceRef: opts.evidenceRef,
      recoveryStepsDropped: dropped.length > 0 ? dropped : undefined,
    },
    target: {
      surfaceType: "legacy-web",
      appId: opts.appId,
      vendorProduct: opts.vendorProduct,
      variant: trace.goal.variant,
      entryPoint,
    },
    inputs: opts.inputSpecs
      // Only parameters the run actually bound become part of the contract.
      // An input nobody typed is a promise the capability cannot keep.
      .filter((spec) => provenance.bound.has(spec.name))
      .map((spec) => ({
        name: spec.name,
        jsonSchema: spec.jsonSchema,
        required: true,
        sensitivity: spec.sensitivity,
        example:
          spec.sensitivity === "public" || spec.sensitivity === "internal"
            ? opts.paramValues[spec.name]
            : undefined,
        description: spec.description,
      })),
    outputs,
    steps,
    successCondition: successCondition(trace, provenance),
    knownOutcomes,
    recoveries: pack?.recoveries ?? [],
    policy: {
      allowlistRef: opts.allowlistRef,
      requiresApprovalForRisk: "irreversible",
      maxSteps: Math.max(40, steps.length * 3),
      maxDurationMs: 120_000,
    },
    // Every freshly compiled capability is a draft. Unattended writes require
    // approval, and approval is a human reading the artifact — including the
    // recovery pack someone attached to it.
    lifecycle: { state: "draft", stability: { runs: 0, successes: 0 } },
  });
}

/* -------------------------------------------------------------- steps ---- */

function compileStep(
  recorded: RecordedStep,
  index: number,
  allowlist: Allowlist,
  provenance: ParamProvenance,
): Step {
  const id = `s${index + 1}`;
  const intent = recorded.rationale.trim() || `${recorded.tool} step ${index + 1}`;
  const risk = classifyAction(recorded.action, recorded.element, allowlist.risk);

  const value = recorded.paramBinding
    ? { $param: recorded.paramBinding }
    : recorded.literalValue !== undefined
      ? { literal: recorded.literalValue }
      : undefined;

  const checkpoint = deriveCheckpoint(recorded, provenance);

  return {
    id,
    intent,
    action: recorded.action.kind as Step["action"],
    target: recorded.element ? descriptorFor(recorded.element, intent, provenance) : undefined,
    value,
    checkpoint,
    waitPolicy: { strategy: checkpoint ? "conditionMet" : "settled", timeoutMs: 10_000 },
    // Transient slowness is the app's problem, not the step's: a bounded retry
    // here is what turns a 503 into a recoverable condition instead of a hard
    // failure. Writes are not retried blindly — see the executor.
    retryPolicy: { maxAttempts: risk === "read_only" ? 3 : 1, backoffMs: 750 },
    risk,
    onCondition: [],
  };
}

/**
 * A checkpoint is proof the step LANDED, not proof we clicked.
 *
 * Preference order, strongest first: the content frame's route changed; a named
 * element appeared that was not there before. When neither holds — typing into
 * a field usually changes nothing observable — we emit no checkpoint rather
 * than a vacuous one, and the following step's checkpoint does the verifying.
 * A checkpoint that always passes is worse than none: it looks like coverage.
 */
function deriveCheckpoint(
  recorded: RecordedStep,
  provenance: ParamProvenance,
): Condition | undefined {
  const moved = changedFrame(recorded.preSnapshot, recorded.postSnapshot);

  if (moved) {
    const pattern = canonicalizeEntryPoint(
      contentUrl(recorded.postSnapshot, moved.framePath),
      provenance,
    );
    return ConditionSchema.parse({
      all: [{ type: "routeMatches", pattern, framePath: moved.framePath }],
      describe: `the ${moved.framePath.join(">") || "main"} frame is at ${pattern}`,
    });
  }

  const appeared = newlyPresent(recorded.preSnapshot, recorded.postSnapshot);
  const anchor = pickAnchor(appeared, provenance);
  if (anchor) {
    return ConditionSchema.parse({
      all: [
        {
          type: "elementPresent",
          role: anchor.role,
          name: anchor.name,
          framePath: [...anchor.framePath],
        },
      ],
      describe: `a ${anchor.role} named "${anchor.name}" is present`,
    });
  }

  return undefined;
}

/**
 * Choose the most durable of the newly-appeared elements to assert on.
 * Headings and buttons are structural; a cell holding this run's member id is
 * not, and asserting on it would pin the capability to the recorded member.
 */
function pickAnchor(
  candidates: readonly UIElement[],
  provenance: ParamProvenance,
): UIElement | undefined {
  const boundValues = [...provenance.bound].map((n) => provenance.values[n]).filter(Boolean);
  const durable = candidates.filter((e) => !boundValues.some((v) => v && e.name.includes(v)));
  const rank = (e: UIElement) =>
    e.role === "heading"
      ? 0
      : e.role === "button"
        ? 1
        : e.role === "columnheader"
          ? 2
          : e.role === "link"
            ? 3
            : 4;
  return [...durable].sort((a, b) => rank(a) - rank(b))[0];
}

function successCondition(trace: DiscoveryTrace, provenance: ParamProvenance): Condition {
  const snapshot =
    trace.successEvidence?.snapshot ?? trace.steps[trace.steps.length - 1]!.postSnapshot;
  const frame = contentRoute(snapshot);

  // Prefer asserting on what the capability RETURNS: if an output was declared,
  // the strongest proof we arrived is that the thing we came for is on screen.
  const output = trace.outputs[0];
  if (output) {
    const el = output.element;
    const anchor = el.nearbyText.rowKey ?? el.nearbyText.columnHeader;
    if (anchor) {
      return ConditionSchema.parse({
        all: [{ type: "elementPresent", role: "cell", name: anchor, framePath: [...el.framePath] }],
        describe: `the ${anchor} row is present in the results grid`,
      });
    }
  }

  const raw = trace.successEvidence?.text ?? "";
  const { text } = generalizeDetectorText(raw, provenance);
  if (text.length >= 3) {
    return ConditionSchema.parse({
      all: [{ type: "textPresent", text, framePath: assertionFrame(snapshot) }],
      describe: `the screen shows "${text}"`,
    });
  }

  return ConditionSchema.parse({
    all: [{ type: "routeMatches", pattern: frame.routePattern, framePath: frame.framePath }],
    describe: `the content frame reached ${frame.routePattern}`,
  });
}

/* ------------------------------------------------------------ helpers ---- */

function dedupeByCode<T extends { code: string }>(items: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(item.code)) seen.set(item.code, item);
  return [...seen.values()];
}
