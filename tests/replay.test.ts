/**
 * Deterministic replay against the real browser and the real app.
 *
 * The point of these tests is the RESULT CONTRACT: that a missing member and a
 * crashed application are different kinds of answer, and that the difference is
 * structural rather than a string a caller has to parse.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp } from "../apps/legacy-cu/app.js";
import { WebSurface } from "../src/surface/web.surface.js";
import { GuardedSurface, PolicyGate } from "../src/policy/gate.js";
import { Redactor } from "../src/policy/redact.js";
import { SessionControl } from "../src/escalation/control.js";
import { RunLog } from "../src/obs/log.js";
import { EvidenceWriter } from "../src/obs/evidence.js";
import { InterventionQueue } from "../src/escalation/intervention.js";
import { InputValidationError, replayCapability } from "../src/replay/executor.js";
import type { ReplayResult } from "../src/replay/result.js";
import { savingsBalanceCapability, testAllowlist } from "./helpers/capability.js";

let server: Server;
let browser: Browser;
let base: string;
let workdir: string;

beforeAll(async () => {
  await new Promise<void>((r) => {
    server = createApp().listen(0, r);
  });
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
  process.env.CUA_TARGET_ORIGIN = base;
  browser = await chromium.launch({ headless: true });
  workdir = mkdtempSync(join(tmpdir(), "cua-replay-"));
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(workdir, { recursive: true, force: true });
});

afterEach(async () => {
  await fetch(`${base}/__control/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
});

/**
 * Arm a fault against a specific route. Targeting matters: the shell loads two
 * iframes before the flow even starts, so an untargeted injection lands on
 * whichever of them wins the race, and the test would be asserting on timing
 * rather than on recovery.
 */
const arm = (mode: string, pathContains: string, count = 1) =>
  fetch(`${base}/__control/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, count, pathContains }),
  });

interface RunHandle {
  result: ReplayResult;
  evidenceDir: string;
  gateChecks: number;
}

let runSeq = 0;

async function replay(
  inputs: Record<string, string>,
  opts: { variant?: string; allowWrites?: boolean; noEscalate?: boolean } = {},
): Promise<RunHandle> {
  const artifact = savingsBalanceCapability(opts.variant ?? "variant-a");
  const runId = `t${++runSeq}`;
  const redactor = new Redactor();
  const evidence = new EvidenceWriter(workdir, runId, redactor);
  const log = new RunLog(evidence.logPath, runId, redactor);
  const control = new SessionControl(join(evidence.dir, "lease.json"));
  const allowlist = testAllowlist(base);

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const gate = new PolicyGate();
  const surface = new GuardedSurface(new WebSurface(page), {
    gate,
    context: () => ({
      mode: "replay",
      allowlist,
      allowWrites: opts.allowWrites ?? false,
      artifactApproved: artifact.lifecycle.state === "approved",
      leaseOwner: control.owner,
    }),
  });

  try {
    const result = await replayCapability(artifact, surface, control, log, evidence, {
      inputs,
      allowWrites: opts.allowWrites ?? false,
      noEscalate: opts.noEscalate,
    });
    return { result, evidenceDir: evidence.dir, gateChecks: gate.checks };
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------ success ---- */

describe("success", () => {
  it("replays the recorded flow and returns the declared output", async () => {
    const { result } = await replay({ memberId: "10042" });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.outputs.savingsBalance).toBe("$8,241.17");
      expect(result.telemetry).toHaveLength(3);
    }
  }, 45_000);

  it("returns a different member's balance from the same artifact", async () => {
    // The proof that parameterization is real: the descriptor for the result
    // row is bound to the input, not to the member we recorded against.
    const { result } = await replay({ memberId: "10077" });
    expect(result.status).toBe("success");
    if (result.status === "success") expect(result.outputs.savingsBalance).toBe("$312.09");
  }, 45_000);

  it("records which locator strategy resolved each step", async () => {
    const { result } = await replay({ memberId: "10042" });
    if (result.status !== "success") throw new Error("expected success");
    expect(result.telemetry.map((t) => t.resolvedBy)).toEqual([
      "role_name",
      "role_name",
      "role_name",
    ]);
    expect(result.telemetry.every((t) => !t.driftSignal)).toBe(true);
  }, 45_000);
});

/* --------------------------------------------------- business outcomes --- */

describe("business outcomes are answers, not crashes", () => {
  it("reports a missing member as data with a typed code", async () => {
    const { result } = await replay({ memberId: "99999" });
    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.code).toBe("member_not_found");
      expect(result.mapsTo).toBe("NOT_FOUND");
    }
  }, 45_000);

  it("reports a permission denial as a business outcome, not a failure", async () => {
    const { result } = await replay({ memberId: "10099" });
    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") expect(result.code).toBe("permission_denied");
  }, 45_000);

  it("rejects an invalid input before a browser is ever launched", async () => {
    await expect(replay({ memberId: "not-an-id" })).rejects.toBeInstanceOf(InputValidationError);
  }, 20_000);

  it("rejects a missing required input", async () => {
    await expect(replay({})).rejects.toThrow(/missing required input 'memberId'/);
  }, 20_000);
});

/* ------------------------------------------------------- recoverable ----- */

describe("recoverable conditions are cleared and the run continues", () => {
  it("acknowledges an unexpected maintenance interstitial", async () => {
    await arm("interstitial", "/frame/member");
    const { result } = await replay({ memberId: "10042" });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      const recovered = result.telemetry.flatMap((t) => t.recoveriesApplied);
      expect(recovered).toContain("maintenance_notice");
    }
  }, 60_000);

  it("re-authenticates after a session timeout and resumes", async () => {
    await arm("session_timeout", "/frame/member");
    const { result } = await replay({ memberId: "10042" });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.telemetry.flatMap((t) => t.recoveriesApplied)).toContain("session_expired");
    }
  }, 60_000);

  it("retries a transient host failure", async () => {
    await arm("transient_503", "/frame/member");
    const { result } = await replay({ memberId: "10042" });
    expect(result.status).toBe("success");
  }, 60_000);
});

/* ------------------------------------------------------ hard failures ---- */

describe("hard failures stop and explain themselves", () => {
  it("returns a debuggable payload on an application error", async () => {
    await arm("app_error_500", "/frame/member");
    const { result } = await replay({ memberId: "10042" });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.classification).toBe("unclassified_condition");
      expect(result.error.stepId).toBeTruthy();
      expect(result.error.stepIntent).toBeTruthy();
      expect(result.error.observed).toContain("application_error");
    }
  }, 45_000);
});

/* -------------------------------------------------------- escalation ----- */

describe("escalation", () => {
  it("degrades to a lower rung, flags drift, then escalates with context", async () => {
    // variant-b relabels everything: 'Member ID' becomes 'Member Number' and
    // 'Search' becomes 'Find Member'. Step 1 survives on the rename-tolerant
    // rung (first textbox in the frame) and is REPORTED as drift rather than
    // passing silently. Step 2 has no such fallback recorded, so the run stops
    // and asks for a human instead of guessing.
    const { result, evidenceDir } = await replay({ memberId: "10042" }, { variant: "variant-b" });
    expect(result.status).toBe("escalated");
    if (result.status !== "escalated") return;

    expect(result.telemetry).toHaveLength(1);
    const s1 = result.telemetry[0]!;
    expect(s1.stepId).toBe("s1");
    expect(s1.resolvedBy).toBe("frame_role_ordinal");
    expect(s1.driftSignal).toBe(true);

    const queue = new InterventionQueue(evidenceDir);
    const open = queue.list();
    expect(open).toHaveLength(1);
    const intervention = open[0]!;
    expect(intervention.stepId).toBe("s2");
    expect(intervention.stepIntent).toContain("submit the search");
    expect(intervention.screenshotPath).toBeTruthy();
    expect(intervention.visibleText).toBeTruthy();
    expect(intervention.resumeToken).toBe(result.resumeToken);
  }, 45_000);

  it("releases the lease as part of escalating, marked as awaiting a human", async () => {
    const { result, evidenceDir } = await replay({ memberId: "10042" }, { variant: "variant-b" });
    expect(result.status).toBe("escalated");
    const control = new SessionControl(join(evidenceDir, "lease.json"));
    // Not "operator" — nobody has arrived yet, and a console must claim the
    // session before it is allowed to drive it.
    expect(control.owner).toBe("awaiting_operator");
    expect(control.lease.interventionId).toBeTruthy();
  }, 45_000);

  it("fails instead of escalating when escalation is disabled", async () => {
    const { result } = await replay(
      { memberId: "10042" },
      { variant: "variant-b", noEscalate: true },
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed")
      expect(result.error.classification).toBe("descriptor_unresolvable");
  }, 45_000);
});
