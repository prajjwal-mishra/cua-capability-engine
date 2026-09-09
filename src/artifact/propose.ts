/**
 * Turn captured human actions into a proposed overlay.
 *
 * This is the missing half of the handoff. Capture already records clicks in
 * role + name + frame path. Without a proposal step, every escalation of the
 * same cause costs a human the same amount forever.
 *
 * A proposal is a document for review, not a mutation. It never overwrites an
 * existing overlay, and it never lowers a step's risk — a human confirmed an
 * irreversible click; promoting that click into unattended automation is a
 * different decision, made by whoever approves the overlay.
 */

import { UIRoleSchema, type CapabilityArtifact, type Step } from "./schema.js";
import type { OverlayInput } from "./overlays.js";
import type { CapturedAction, Intervention } from "../escalation/intervention.js";

type Insertion = { after: string; step: Step };

const PROPOSABLE = new Set(["click", "type", "select"]);

export interface OverlayProposal {
  readonly overlay: OverlayInput;
  /** Why each captured action was kept or dropped. */
  readonly notes: readonly string[];
}

export function proposeOverlayFromIntervention(
  base: CapabilityArtifact,
  intervention: Intervention,
  opts: { tenant: string; variant?: string },
): OverlayProposal {
  const captured = intervention.resolution?.capturedActions ?? [];
  const notes: string[] = [];
  const insertSteps: Insertion[] = [];
  const after = anchorStep(base, intervention.stepId);
  if (after !== intervention.stepId) {
    notes.push(
      `anchored after '${after}' because '${intervention.stepId}' is not a step on the base artifact`,
    );
  }

  let kept = 0;
  for (const action of captured) {
    const verdict = consider(base, action, insertSteps);
    notes.push(`${action.describe}: ${verdict.reason}`);
    if (!verdict.keep) continue;
    kept += 1;
    const id = `${after}_human_${kept}`;
    insertSteps.push({
      after,
      step: {
        id,
        intent: `operator ${action.describe}`,
        action: action.kind === "type" ? "type" : action.kind === "select" ? "select" : "click",
        target: {
          intent: action.describe,
          role: UIRoleSchema.parse(action.role),
          framePath: [...action.framePath],
          strategies: [
            {
              kind: "role_name",
              confidence: 0.9,
              role: UIRoleSchema.parse(action.role),
              name: action.name ?? "",
              match: "exact",
            },
          ],
        },
        risk: "irreversible",
        retryPolicy: { maxAttempts: 1, backoffMs: 500 },
        waitPolicy: { strategy: "settled", timeoutMs: 10_000 },
        onCondition: [],
      },
    });
  }

  const overlay: OverlayInput = {
    overlayId: `proposed.${opts.tenant}.${base.capabilityId}`,
    tenant: opts.tenant,
    variant: opts.variant,
    basedOn: { capabilityId: base.capabilityId, versionRange: `^${base.version}` },
    describe:
      `PROPOSAL from intervention ${intervention.interventionId}. ` +
      `Review before applying. Risk is left at irreversible on purpose: a human ` +
      `just confirmed these clicks, and promoting them to unattended is a separate approval.`,
    patch: {
      steps: {},
      insertSteps,
      outputs: {},
      knownOutcomes: [],
      recoveries: [],
    },
  };

  if (kept === 0) {
    notes.push("no new steps: every captured action was already on the base or was not a control");
  }

  return { overlay, notes };
}

function consider(
  base: CapabilityArtifact,
  action: CapturedAction,
  pending: readonly Insertion[],
): { keep: boolean; reason: string } {
  if (!PROPOSABLE.has(action.kind)) {
    return { keep: false, reason: `skipped (${action.kind} is not a control action)` };
  }
  const role = UIRoleSchema.safeParse(action.role);
  if (!role.success) {
    return { keep: false, reason: `skipped (role '${action.role ?? ""}' is not a recorded UI role)` };
  }
  if (!action.name) {
    return { keep: false, reason: "skipped (no accessible name — cannot record a locator)" };
  }
  if (alreadyNamed(base, role.data, action.name) || pendingNamed(pending, action.name)) {
    return {
      keep: false,
      reason: `already represented as role_name "${action.name}" — overlay would duplicate it`,
    };
  }
  return { keep: true, reason: `proposed insert for ${role.data} "${action.name}"` };
}

function alreadyNamed(base: CapabilityArtifact, role: string, name: string): boolean {
  for (const step of base.steps) {
    for (const s of step.target?.strategies ?? []) {
      if (s.kind === "role_name" && s.role === role && s.name === name) return true;
    }
  }
  return false;
}

function pendingNamed(pending: readonly Insertion[], name: string): boolean {
  return pending.some((ins) =>
    (ins.step.target?.strategies ?? []).some(
      (s) => s.kind === "role_name" && "name" in s && s.name === name,
    ),
  );
}

/** Prefer the stuck step; if it only exists on a resolved overlay, walk back
 *  to a base step the insert can actually anchor on. */
export function anchorStep(base: CapabilityArtifact, stepId: string): string {
  if (base.steps.some((s) => s.id === stepId)) return stepId;
  const prefix = stepId.replace(/[a-z]+$/u, "");
  if (prefix && prefix !== stepId && base.steps.some((s) => s.id === prefix)) return prefix;
  return base.steps[base.steps.length - 1]?.id ?? stepId;
}
