/**
 * The CapabilityArtifact: a recorded flow, promoted to a callable capability.
 *
 * Zod is the single source of truth - TypeScript types are inferred from it and
 * the agent-facing JSON Schema is emitted from it, so the contract a calling
 * agent reads and the contract replay enforces cannot drift apart.
 *
 * Four properties this schema is shaped around:
 *
 *  1. DECOUPLED FROM THE TRANSCRIPT. The model's reasoning is evidence, not the
 *     artifact. Nothing here depends on what the LLM said - every mechanical
 *     fact comes from a recorded snapshot. Re-running discovery with a
 *     different model should produce the same artifact.
 *
 *  2. DETECTORS AND RECOVERIES ARE DATA. A reviewer can read exactly which
 *     conditions this capability recognises and what it will do about them,
 *     without reading our source. That is what makes "approved" mean something.
 *
 *  3. PARAMETERIZED, NOT PINNED. Routes and values that came from inputs are
 *     bindings, so the capability is not welded to the member it was recorded
 *     against.
 *
 *  4. NO PII, EVER. Inputs carry a sensitivity class; examples are synthetic;
 *     credentials are referenced by name and never valued.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const SCHEMA_VERSION = "1.0.0";

/* ------------------------------------------------------- descriptors ----- */

export const UIRoleSchema = z.enum([
  "textbox",
  "button",
  "link",
  "combobox",
  "checkbox",
  "radio",
  "heading",
  "cell",
  "columnheader",
  "row",
  "table",
  "text",
  "generic",
]);

const BoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const ResolutionStrategySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("role_name"),
    confidence: z.number().min(0).max(1),
    role: UIRoleSchema,
    name: z.string(),
    match: z.enum(["exact", "normalized"]),
  }),
  z.object({
    kind: z.literal("label_anchor"),
    confidence: z.number().min(0).max(1),
    role: UIRoleSchema,
    labelText: z.string(),
    relation: z.enum(["same-row", "same-column", "preceding-text"]),
  }),
  z.object({
    kind: z.literal("table_cell"),
    confidence: z.number().min(0).max(1),
    columnHeader: z.string(),
    rowKey: z.string(),
  }),
  z.object({
    kind: z.literal("frame_role_ordinal"),
    confidence: z.number().min(0).max(1),
    role: UIRoleSchema,
    name: z.string().optional(),
    ordinal: z.number().int().min(0),
    /** Whether `ordinal` counts within role+name or within role alone. */
    ordinalScope: z.enum(["role_and_name", "role"]).default("role_and_name"),
  }),
  z.object({
    kind: z.literal("structural"),
    confidence: z.number().min(0).max(1),
    path: z.string(),
  }),
  z.object({
    kind: z.literal("bounds"),
    confidence: z.literal(0),
    bounds: BoundsSchema,
  }),
]);

export const ElementDescriptorSchema = z.object({
  intent: z.string(),
  role: UIRoleSchema,
  framePath: z.array(z.string()),
  strategies: z.array(ResolutionStrategySchema).min(1),
});

/* ---------------------------------------------------------- conditions --- */

/**
 * A condition is a conjunction of clauses evaluated against a UISnapshot.
 * Checkpoints, preconditions, outcome detectors and recovery triggers are all
 * the same shape on purpose: one evaluator, one thing to reason about, and a
 * reviewer learns the vocabulary once.
 */
export const ConditionClauseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("textPresent"),
    text: z.string(),
    framePath: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("textAbsent"),
    text: z.string(),
    framePath: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("elementPresent"),
    role: UIRoleSchema,
    name: z.string().optional(),
    framePath: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("elementAbsent"),
    role: UIRoleSchema,
    name: z.string().optional(),
    framePath: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("routeMatches"),
    pattern: z.string(),
    framePath: z.array(z.string()).optional(),
  }),
]);

export const ConditionSchema = z.object({
  all: z.array(ConditionClauseSchema).min(1),
  /** Human-readable, so the artifact explains itself in a review. */
  describe: z.string().optional(),
});

/* -------------------------------------------------------------- values --- */

/** A step's value is a literal, an input binding, or an earlier step's output. */
export const ValueBindingSchema = z.union([
  z.object({ literal: z.string() }),
  z.object({ $param: z.string() }),
  z.object({ $output: z.string() }),
]);

/* ------------------------------------------------------------- inputs ---- */

export const SensitivitySchema = z.enum(["public", "internal", "pii", "secret"]);

export const CapabilityInputSchema = z.object({
  name: z.string(),
  jsonSchema: z.record(z.unknown()),
  required: z.boolean().default(true),
  sensitivity: SensitivitySchema.default("internal"),
  /** Synthetic only. Enforced by review, and by the fact that discovery runs
   *  against seeded fake data. */
  example: z.string().optional(),
  description: z.string().optional(),
});

export const ParseRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text") }),
  z.object({ kind: z.literal("currency") }),
  z.object({ kind: z.literal("regex"), pattern: z.string(), group: z.number().int().default(1) }),
]);

export const CapabilityOutputSchema = z.object({
  name: z.string(),
  jsonSchema: z.record(z.unknown()),
  required: z.boolean().default(true),
  extraction: z.object({
    descriptor: ElementDescriptorSchema,
    parse: ParseRuleSchema,
  }),
  sensitivity: SensitivitySchema.default("internal"),
});

/* -------------------------------------------------------------- steps ---- */

export const RiskClassSchema = z.enum(["read_only", "reversible_write", "irreversible"]);

export const StepActionSchema = z.enum([
  "navigate",
  "click",
  "type",
  "select",
  "key",
  "read",
  "waitFor",
  "scroll",
]);

export const WaitPolicySchema = z.object({
  /** Condition-based, never a bare sleep. `conditionMet` waits on the step's
   *  own checkpoint, which is the strongest signal we have that we arrived. */
  strategy: z.enum(["settled", "elementPresent", "conditionMet"]).default("settled"),
  timeoutMs: z.number().int().positive().default(10_000),
});

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).default(1),
  backoffMs: z.number().int().min(0).default(500),
});

export const StepSchema = z.object({
  id: z.string(),
  intent: z.string(),
  action: StepActionSchema,
  target: ElementDescriptorSchema.optional(),
  value: ValueBindingSchema.optional(),
  /** Verified before acting. On resume after a human handoff this is what stops
   *  us assuming the page is where we left it. */
  precondition: ConditionSchema.optional(),
  /** Verified after acting: proof the step landed, rather than proof we clicked. */
  checkpoint: ConditionSchema.optional(),
  waitPolicy: WaitPolicySchema.default({ strategy: "settled", timeoutMs: 10_000 }),
  retryPolicy: RetryPolicySchema.default({ maxAttempts: 1, backoffMs: 500 }),
  risk: RiskClassSchema.default("read_only"),
  /** Per-step branch into a declared outcome or recovery, by code. */
  onCondition: z.array(z.object({ detector: ConditionSchema, outcome: z.string() })).default([]),
});

/* --------------------------------------------------- outcomes & recovery -- */

export const OutcomeSeveritySchema = z.enum(["business", "recoverable", "hard"]);

export const KnownOutcomeSchema = z.object({
  code: z.string(),
  detector: ConditionSchema,
  severity: OutcomeSeveritySchema,
  message: z.string(),
  /** Optional mapping into the caller's own vocabulary. */
  mapsTo: z.string().optional(),
});

export const RecoveryActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), target: ElementDescriptorSchema }),
  z.object({ kind: z.literal("navigate"), url: z.string() }),
  z.object({ kind: z.literal("wait"), ms: z.number().int().positive() }),
  /** Re-request the failing frame. For a transient server error the step's
   *  target is not on the error page, so the request must be retried rather
   *  than the click repeated. */
  z.object({ kind: z.literal("reload"), framePath: z.array(z.string()).optional() }),
  /** Re-run the step that tripped the recovery. The bounded loop lives in the
   *  executor; this only declares intent. */
  z.object({ kind: z.literal("retryStep") }),
]);

export const RecoverySchema = z.object({
  code: z.string(),
  detector: ConditionSchema,
  actions: z.array(RecoveryActionSchema).min(1),
  maxAttempts: z.number().int().min(1).default(2),
  describe: z.string().optional(),
});

/* ------------------------------------------------------------ artifact --- */

export const ProvenanceSchema = z.object({
  discoveredBy: z.string(),
  runId: z.string(),
  recordedAt: z.string(),
  gitSha: z.string().optional(),
  surfaceType: z.string(),
  /** Deliberately NOT the transcript. Evidence lives in /evidence; the artifact
   *  records only where to find it. */
  evidenceRef: z.string().optional(),
  /** Exceptional states the discovery run hit, whose handling was dropped from
   *  the steps because a declared recovery already covers them. Surfaced so a
   *  reviewer can check that claim rather than take it on trust. */
  recoveryStepsDropped: z.array(z.string()).optional(),
});

export const TargetSchema = z.object({
  surfaceType: z.enum(["web", "legacy-web", "desktop"]),
  appId: z.string(),
  vendorProduct: z.string(),
  variant: z.string().optional(),
  /** A route PATTERN, parameterized - never the concrete recorded URL. */
  entryPoint: z.string(),
});

const StabilityRecordSchema = z.object({
  runs: z.number().int().min(0).default(0),
  successes: z.number().int().min(0).default(0),
  lastVerifiedAt: z.string().optional(),
});

export const LifecycleSchema = z.object({
  state: z.enum(["draft", "approved", "deprecated"]).default("draft"),
  /** Runs against the tenant this capability was recorded for. */
  stability: StabilityRecordSchema.default({ runs: 0, successes: 0 }),
  /**
   * The same signal, per tenant.
   *
   * One global number is the wrong shape once a capability is reused. A flow
   * can be rock-solid at the institution it was recorded against and broken at
   * the one whose overlay is half-finished, and averaging those together hides
   * the only fact anybody needed: WHERE it is broken. It also means probing a
   * capability against a new tenant - the thing you must do to find out what
   * needs overlaying - silently degrades its reputation everywhere else.
   */
  stabilityByTenant: z.record(z.string(), StabilityRecordSchema).default({}),
});

export const CapabilityPolicySchema = z.object({
  allowlistRef: z.string(),
  requiresApprovalForRisk: RiskClassSchema.default("irreversible"),
  maxSteps: z.number().int().positive().default(40),
  maxDurationMs: z.number().int().positive().default(120_000),
});

export const CapabilityArtifactSchema = z.object({
  schemaVersion: z.string(),
  capabilityId: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  provenance: ProvenanceSchema,
  target: TargetSchema,
  inputs: z.array(CapabilityInputSchema).default([]),
  outputs: z.array(CapabilityOutputSchema).default([]),
  steps: z.array(StepSchema).min(1),
  successCondition: ConditionSchema,
  knownOutcomes: z.array(KnownOutcomeSchema).default([]),
  recoveries: z.array(RecoverySchema).default([]),
  policy: CapabilityPolicySchema,
  lifecycle: LifecycleSchema,
});

export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
export type ElementDescriptor = z.infer<typeof ElementDescriptorSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type ConditionClause = z.infer<typeof ConditionClauseSchema>;
export type KnownOutcome = z.infer<typeof KnownOutcomeSchema>;
export type Recovery = z.infer<typeof RecoverySchema>;
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;
export type CapabilityInput = z.infer<typeof CapabilityInputSchema>;
export type CapabilityOutput = z.infer<typeof CapabilityOutputSchema>;
export type ValueBinding = z.infer<typeof ValueBindingSchema>;
export type ParseRule = z.infer<typeof ParseRuleSchema>;

/* --------------------------------------------- agent-facing contract ----- */

/**
 * What a calling agent needs to invoke this capability: the typed input and
 * output shapes, and nothing about how the flow is executed. The steps are our
 * business; the contract is theirs.
 */
export function toolContract(artifact: CapabilityArtifact): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const input of artifact.inputs) {
    properties[input.name] = { ...input.jsonSchema, description: input.description };
    if (input.required) required.push(input.name);
  }
  const outProps: Record<string, unknown> = {};
  for (const o of artifact.outputs) outProps[o.name] = o.jsonSchema;

  return {
    name: artifact.capabilityId,
    description: artifact.description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    outputSchema: { type: "object", properties: outProps },
  };
}

/** The full artifact schema as JSON Schema, for documentation and validation. */
export function artifactJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(CapabilityArtifactSchema, "CapabilityArtifact") as Record<string, unknown>;
}
