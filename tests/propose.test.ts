/**
 * Captured human actions become a proposed overlay, not a silent mutation.
 *
 * The properties that matter: a click the artifact already names is not
 * duplicated, a click it does not name is inserted after the stuck step, and
 * the proposed step stays irreversible so a reviewer still has to decide
 * whether unattended automation is allowed to do what the human just did.
 */

import { describe, expect, it } from "vitest";
import { OverlaySchema } from "../src/artifact/overlays.js";
import { proposeOverlayFromIntervention, anchorStep } from "../src/artifact/propose.js";
import type { Intervention } from "../src/escalation/intervention.js";
import { savingsBalanceCapability } from "./helpers/capability.js";

function intervention(partial: Partial<Intervention> & Pick<Intervention, "stepId">): Intervention {
  return {
    interventionId: "int-test",
    runId: "run-test",
    capability: "test.member.savings_balance@1.0.0",
    goal: "lookup",
    stepIntent: "stuck",
    reason: "irreversible",
    classification: "policy_denied",
    createdAt: "2026-09-01T00:00:00.000Z",
    flow: [],
    resumeToken: "tok",
    status: "resolved",
    resolution: {
      resolvedAt: "2026-09-01T00:00:01.000Z",
      note: "done",
      capturedActions: [],
    },
    ...partial,
  };
}

describe("overlay proposal from a human handoff", () => {
  it("inserts a click the base artifact does not already name", () => {
    const base = savingsBalanceCapability();
    const { overlay, notes } = proposeOverlayFromIntervention(
      base,
      intervention({
        stepId: "s3",
        resolution: {
          resolvedAt: "2026-09-01T00:00:01.000Z",
          note: "",
          capturedActions: [
            {
              at: "2026-09-01T00:00:01.000Z",
              kind: "click",
              describe: 'clicked the button "Commit Sub-Account"',
              role: "button",
              name: "Commit Sub-Account",
              framePath: ["contentFrame"],
            },
          ],
        },
      }),
      { tenant: "summit-fcu" },
    );

    const parsed = OverlaySchema.parse(overlay);
    expect(parsed.patch.insertSteps).toHaveLength(1);
    const step = parsed.patch.insertSteps[0]!;
    expect(step.after).toBe("s3");
    expect(step.step.risk).toBe("irreversible");
    expect(step.step.target?.strategies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "role_name",
          role: "button",
          name: "Commit Sub-Account",
        }),
      ]),
    );
    expect(notes.some((n) => n.includes("proposed insert"))).toBe(true);
  });

  it("does not duplicate a control the recording already has", () => {
    const base = savingsBalanceCapability();
    const { overlay, notes } = proposeOverlayFromIntervention(
      base,
      intervention({
        stepId: "s2",
        resolution: {
          resolvedAt: "2026-09-01T00:00:01.000Z",
          note: "",
          capturedActions: [
            {
              at: "2026-09-01T00:00:01.000Z",
              kind: "click",
              describe: 'clicked the button "Search"',
              role: "button",
              name: "Search",
              framePath: ["contentFrame"],
            },
            {
              at: "2026-09-01T00:00:01.100Z",
              kind: "submit",
              describe: "submitted the form",
              role: "form",
              name: "/search",
              framePath: ["contentFrame"],
            },
          ],
        },
      }),
      { tenant: "summit-fcu" },
    );

    expect(OverlaySchema.parse(overlay).patch.insertSteps).toHaveLength(0);
    expect(notes.some((n) => n.includes("already represented"))).toBe(true);
    expect(notes.some((n) => n.includes("not a control action"))).toBe(true);
  });

  it("anchors on a base step when the stuck id only exists on a resolved overlay", () => {
    expect(anchorStep(savingsBalanceCapability(), "s8b")).toBe("s3");
    expect(anchorStep(savingsBalanceCapability(), "s2")).toBe("s2");
  });
});
