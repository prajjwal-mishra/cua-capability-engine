/**
 * Per-tenant specialization.
 *
 * DESIGN DEVIATION, stated plainly: overlays are SEPARATE DOCUMENTS that
 * reference a base capability, not an `overrides` map embedded inside the base
 * artifact.
 *
 * Embedding them is simpler to serialize and was the obvious first design. It
 * fails at the scale this system actually targets. Hundreds of tenants share
 * one vendor product; if their patches live inside the base, then every tenant's
 * drift re-versions a document all of them share, one file accumulates hundreds
 * of editors, and the ownership boundary collapses — the base belongs to
 * whoever maintains the recording, the patch belongs to the institution.
 *
 * As separate documents: a tenant's drift is a small diff in a file only that
 * tenant owns, the base can be re-recorded without touching any overlay, and an
 * overlay pins the base range it was reviewed against, so a base bump that
 * invalidates it fails loudly instead of silently mis-patching.
 */

import { z } from "zod";
import {
  CapabilityArtifactSchema,
  ElementDescriptorSchema,
  ConditionSchema,
  KnownOutcomeSchema,
  RecoverySchema,
  StepSchema,
  type CapabilityArtifact,
} from "./schema.js";
import { satisfies } from "./version.js";

/** Sparse patch of one step. Absent keys are inherited from the base. */
export const StepPatchSchema = StepSchema.partial().extend({
  /** Replaces the base descriptor wholesale rather than merging ladders —
   *  a half-merged strategy list is worse than either version alone. */
  target: ElementDescriptorSchema.optional(),
  checkpoint: ConditionSchema.optional(),
});

export const OverlaySchema = z.object({
  overlayId: z.string(),
  tenant: z.string(),
  variant: z.string().optional(),
  basedOn: z.object({
    capabilityId: z.string(),
    /** Semver range this overlay was reviewed against. */
    versionRange: z.string().default("*"),
  }),
  describe: z.string().optional(),
  patch: z.object({
    /** Steps to patch, keyed by step id. Unknown ids are an error, not a no-op:
     *  silently ignoring them is how an overlay rots undetected. */
    steps: z.record(StepPatchSchema).default({}),
    /** Steps to insert, each anchored after an existing step id. This is what
     *  a tenant with one extra confirmation screen needs. */
    insertSteps: z.array(z.object({ after: z.string(), step: StepSchema })).default([]),
    outputs: z
      .record(z.object({ extraction: z.object({ descriptor: ElementDescriptorSchema }) }))
      .default({}),
    knownOutcomes: z.array(KnownOutcomeSchema).default([]),
    recoveries: z.array(RecoverySchema).default([]),
    successCondition: ConditionSchema.optional(),
    entryPoint: z.string().optional(),
  }),
});

export type Overlay = z.infer<typeof OverlaySchema>;

export class OverlayMismatch extends Error {}

/**
 * Apply an overlay to a base artifact. Pure — takes two documents, returns a
 * third — so a reviewer can diff resolved(base, overlay) against base and see
 * exactly what a tenant changed.
 */
export function applyOverlay(base: CapabilityArtifact, overlay: Overlay): CapabilityArtifact {
  if (overlay.basedOn.capabilityId !== base.capabilityId) {
    throw new OverlayMismatch(
      `overlay ${overlay.overlayId} targets ${overlay.basedOn.capabilityId}, not ${base.capabilityId}`,
    );
  }
  if (!satisfies(base.version, overlay.basedOn.versionRange)) {
    throw new OverlayMismatch(
      `overlay ${overlay.overlayId} was reviewed against ${overlay.basedOn.versionRange}; base is ${base.version}. ` +
        `Re-review the overlay rather than replaying an unreviewed combination.`,
    );
  }

  const unknown = Object.keys(overlay.patch.steps).filter(
    (id) => !base.steps.some((s) => s.id === id),
  );
  if (unknown.length > 0) {
    throw new OverlayMismatch(
      `overlay ${overlay.overlayId} patches steps that no longer exist: ${unknown.join(", ")}`,
    );
  }

  let steps = base.steps.map((step) => {
    const patch = overlay.patch.steps[step.id];
    return patch ? ({ ...step, ...patch } as typeof step) : step;
  });

  for (const insertion of overlay.patch.insertSteps) {
    const idx = steps.findIndex((s) => s.id === insertion.after);
    if (idx === -1) {
      throw new OverlayMismatch(
        `overlay ${overlay.overlayId} anchors an inserted step after '${insertion.after}', which does not exist`,
      );
    }
    steps = [...steps.slice(0, idx + 1), insertion.step, ...steps.slice(idx + 1)];
  }

  const outputs = base.outputs.map((o) => {
    const patch = overlay.patch.outputs[o.name];
    return patch
      ? { ...o, extraction: { ...o.extraction, descriptor: patch.extraction.descriptor } }
      : o;
  });

  return CapabilityArtifactSchema.parse({
    ...base,
    steps,
    outputs,
    successCondition: overlay.patch.successCondition ?? base.successCondition,
    knownOutcomes: [...base.knownOutcomes, ...overlay.patch.knownOutcomes],
    recoveries: [...base.recoveries, ...overlay.patch.recoveries],
    target: {
      ...base.target,
      variant: overlay.variant ?? base.target.variant,
      entryPoint: overlay.patch.entryPoint ?? base.target.entryPoint,
    },
  });
}

/** What a tenant actually changed — the reviewable unit. */
export function describeOverlay(overlay: Overlay): string[] {
  const lines: string[] = [];
  for (const [id, patch] of Object.entries(overlay.patch.steps)) {
    const fields = Object.keys(patch).join(", ");
    lines.push(`step ${id}: patched ${fields}`);
  }
  for (const ins of overlay.patch.insertSteps) {
    lines.push(`step ${ins.step.id}: inserted after ${ins.after} (${ins.step.intent})`);
  }
  for (const [name] of Object.entries(overlay.patch.outputs)) {
    lines.push(`output ${name}: re-targeted`);
  }
  if (overlay.patch.successCondition) lines.push("successCondition: replaced");
  return lines;
}
