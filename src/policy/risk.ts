/**
 * Risk classification.
 *
 * The default that matters: an action we cannot confidently classify as safe is
 * NOT treated as safe. In a regulated back office the cost of one wrong
 * irreversible action dominates the cost of a hundred unnecessary escalations,
 * so the asymmetry is deliberate and the bias is toward stopping.
 */

import type { SurfaceAction, UIElement } from "../surface/types.js";

export type RiskClass = "read_only" | "reversible_write" | "irreversible";

export interface RiskPatterns {
  /** Control names that commit something that cannot be taken back. */
  readonly irreversible: readonly string[];
  /** Control names that write state but can be undone or re-done. */
  readonly write: readonly string[];
  /** Control names known to be pure navigation or query in THIS product —
   *  a Search button submits a form but changes nothing. Which controls those
   *  are is per-app knowledge, so it lives in the app's allowlist config
   *  rather than in a heuristic here. */
  readonly readOnly: readonly string[];
}

export const RISK_ORDER: Record<RiskClass, number> = {
  read_only: 0,
  reversible_write: 1,
  irreversible: 2,
};

const matches = (name: string, patterns: readonly string[]): boolean => {
  const n = name.toLowerCase();
  return patterns.some((p) => n.includes(p.toLowerCase()));
};

/**
 * Classify a single action. `element` is the resolved target, when there is one.
 *
 * Honest about its limits: this reads control names, so a "Continue" button
 * that quietly wires funds classifies as a write, not as irreversible. That is
 * a real hole, and the mitigation is not a cleverer regex — it is that
 * irreversible steps are declared in the artifact and reviewed by a human
 * before the capability is ever approved. The patterns here are a backstop for
 * DISCOVERY, where no reviewed artifact exists yet.
 */
export function classifyAction(
  action: SurfaceAction,
  element: UIElement | undefined,
  patterns: RiskPatterns,
): RiskClass {
  switch (action.kind) {
    case "navigate":
    case "read":
    case "waitFor":
    case "scroll":
    case "reload":
      return "read_only";

    case "key":
      // A bare Enter can submit the form under the cursor.
      return action.key === "Enter" ? "reversible_write" : "read_only";

    case "type":
    case "select":
      // Risk is about durable effect on the system of record. Keystrokes are
      // not durable; the submit that follows them is. Classifying typing as a
      // write would make every read-only lookup require --allow-writes, which
      // trains operators to pass the flag always — the opposite of safe.
      // Typing into a sensitive field is blocked separately, by name, in the
      // gate's forbidden-field rule, regardless of this classification.
      return "read_only";

    case "click": {
      const name = element?.name ?? "";
      // Irreversible wins over every other match, always.
      if (matches(name, patterns.irreversible)) return "irreversible";
      if (matches(name, patterns.readOnly)) return "read_only";
      if (matches(name, patterns.write)) return "reversible_write";
      // A link is navigation in these apps. An unrecognised button is not
      // assumed safe — deny-by-default applies to risk too.
      if (element?.role === "link") return "read_only";
      return "reversible_write";
    }
  }
}

export function riskAtLeast(actual: RiskClass, threshold: RiskClass): boolean {
  return RISK_ORDER[actual] >= RISK_ORDER[threshold];
}

/**
 * Combine the heuristic classification with the risk a reviewed artifact
 * declares for this step. We take the HIGHER of the two: a reviewer who has
 * read the flow can mark a bland-looking 'Continue' as irreversible, but no
 * artifact can launder a risky action into a safe one.
 */
export function effectiveRisk(classified: RiskClass, declared: RiskClass | undefined): RiskClass {
  if (declared === undefined) return classified;
  return RISK_ORDER[declared] > RISK_ORDER[classified] ? declared : classified;
}
