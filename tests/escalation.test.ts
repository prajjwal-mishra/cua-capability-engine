/**
 * Human-in-the-loop, against a real browser, a real app, and the real console.
 *
 * The claim being tested is narrow and specific: the human operates the SAME
 * session the automation was driving, the lease has exactly one owner at every
 * instant, what the human did is recorded, and the resume continues from the
 * live page instead of starting over. Every one of those is a property you can
 * get wrong while still having something that looks like an escalation, which
 * is why they are asserted rather than described.
 *
 * The console is driven over its HTTP API — the same API its own page uses — so
 * these tests exercise the actual control-transfer path, not a stand-in for it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import {
  InputValidationError,
  replayCapability,
  VERIFY_ONLY,
} from "../src/replay/executor.js";
import { startOperatorConsole, type Handback } from "../src/escalation/operator-console/server.js";
import type { CapabilityArtifact } from "../src/artifact/schema.js";
import type { ReplayResult } from "../src/replay/result.js";
import {
  savingsBalanceCapability,
  testAllowlist,
  VARIANT_B_LABELS,
} from "./helpers/capability.js";

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
  workdir = mkdtempSync(join(tmpdir(), "cua-escalation-"));
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
 * A capability specialized for variant-b EXCEPT for the search button, whose
 * descriptor still names variant-a's label and has no fallback.
 *
 * This is the realistic shape of a partially-drifted tenant: almost everything
 * resolves, one control does not, and there is no safe guess available. It
 * escalates at s2 with the flow otherwise intact, so the resume after handoff
 * can actually complete — which is the half of a handoff that is easy to skip.
 */
function partiallyDriftedCapability(): CapabilityArtifact {
  const artifact = savingsBalanceCapability("variant-b", VARIANT_B_LABELS);
  return {
    ...artifact,
    steps: artifact.steps.map((step) =>
      step.id === "s2"
        ? {
            ...step,
            target: {
              ...step.target!,
              strategies: [
                {
                  kind: "role_name" as const,
                  confidence: 0.9,
                  role: "button" as const,
                  name: "Search",
                  match: "exact" as const,
                },
              ],
            },
          }
        : step,
    ),
  };
}

interface Harness {
  run: (opts?: { resumeAtStepId?: string }) => Promise<ReplayResult>;
  control: SessionControl;
  evidenceDir: string;
  logRecords: () => Record<string, unknown>[];
  close: () => Promise<void>;
  page: import("playwright").Page;
  web: WebSurface;
  redactor: Redactor;
  log: RunLog;
  gate: PolicyGate;
  allowlist: ReturnType<typeof testAllowlist>;
}

let seq = 0;

async function harness(artifact: CapabilityArtifact): Promise<Harness> {
  const runId = `e${++seq}`;
  const redactor = new Redactor();
  const evidence = new EvidenceWriter(workdir, runId, redactor);
  const log = new RunLog(evidence.logPath, runId, redactor);
  const control = new SessionControl(join(evidence.dir, "lease.json"));
  const allowlist = testAllowlist(base);

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const web = new WebSurface(page);
  const gate = new PolicyGate();
  const surface = new GuardedSurface(web, {
    gate,
    context: () => ({
      mode: "replay",
      allowlist,
      allowWrites: false,
      artifactApproved: artifact.lifecycle.state === "approved",
      leaseOwner: control.owner,
    }),
  });

  return {
    run: (opts = {}) =>
      replayCapability(artifact, surface, control, log, evidence, {
        inputs: { memberId: "10042" },
        allowWrites: false,
        resumeAtStepId: opts.resumeAtStepId,
      }),
    control,
    evidenceDir: evidence.dir,
    logRecords: () =>
      readFileSync(evidence.logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    page,
    web,
    redactor,
    log,
    gate,
    allowlist,
    close: () => context.close(),
  };
}

/** Bring up a console attached to a paused run, as `replay --attended` does. */
async function attachConsole(h: Harness, interventionId: string) {
  const queue = new InterventionQueue(h.evidenceDir);
  const intervention = queue.get(interventionId)!;
  let resolveHandback: (v: Handback) => void = () => {};
  const handedBack = new Promise<Handback>((r) => {
    resolveHandback = r;
  });

  const console_ = await startOperatorConsole({
    port: 0,
    runsRoot: workdir,
    live: {
      page: h.page,
      surface: h.web,
      control: h.control,
      redactor: h.redactor,
      gate: h.gate,
      allowlist: h.allowlist,
      queue,
      intervention,
      log: h.log,
    },
    onHandback: resolveHandback,
  });

  const raw = (path: string, body?: unknown): Promise<Response> =>
    fetch(`${console_.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const api = async <T>(path: string, body?: unknown): Promise<T> =>
    (await (await raw(path, body)).json()) as T;

  return { api, raw, queue, handedBack, close: console_.close };
}

/* ------------------------------------------------------------ detection --- */

describe("routing an intervention", () => {
  it("carries enough context for a human who was not watching", async () => {
    const h = await harness(partiallyDriftedCapability());
    try {
      const result = await h.run();
      expect(result.status).toBe("escalated");
      if (result.status !== "escalated") return;

      const intervention = new InterventionQueue(h.evidenceDir).get(result.interventionId)!;

      expect(intervention.stepId).toBe("s2");
      expect(intervention.classification).toBe("descriptor_unresolvable");
      expect(intervention.reason).toMatch(/no element matched/);
      // The whole flow, so the operator can say where to pick up rather than
      // being asked to invent a step id.
      expect(intervention.flow.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
      // What the automation could see, and a picture of it.
      expect(intervention.visibleText).toBeTruthy();
      expect(intervention.screenshotPath).toMatch(/\.png$/);
      expect(intervention.resumeToken).toBeTruthy();
      expect(intervention.status).toBe("open");
    } finally {
      await h.close();
    }
  }, 60_000);

  it("releases the lease as part of stopping, without claiming a human arrived", async () => {
    const h = await harness(partiallyDriftedCapability());
    try {
      const result = await h.run();
      expect(result.status).toBe("escalated");
      // Persisted, because the console is a different process.
      const onDisk = JSON.parse(readFileSync(join(h.evidenceDir, "lease.json"), "utf8"));
      expect(onDisk.owner).toBe("awaiting_operator");
      expect(h.control.owner).toBe("awaiting_operator");

      // And automation is now locked out at the choke point, not by convention.
      const second = await h.run({ resumeAtStepId: "s2" });
      expect(second.status).toBe("escalated");
    } finally {
      await h.close();
    }
  }, 60_000);
});

/* ------------------------------------------------------- control transfer -- */

describe("taking control of the live session and handing it back", () => {
  it("lets a human finish the step, records what they did, and resumes to success", async () => {
    const h = await harness(partiallyDriftedCapability());
    try {
      const escalated = await h.run();
      expect(escalated.status).toBe("escalated");
      if (escalated.status !== "escalated") return;

      const c = await attachConsole(h, escalated.interventionId);
      try {
        await c.api("/api/live/take", {});
        expect(h.control.owner).toBe("operator");
        expect(c.queue.get(escalated.interventionId)!.status).toBe("operator_control");

        // The operator looks at the live page — the SAME page, mid-flow, with
        // the member id the automation already typed still in the box.
        const snap = await c.api<{
          url: string;
          elements: { ref: string; role: string; name: string }[];
        }>("/api/live/snapshot");
        const button = snap.elements.find((e) => e.name === "Find Member");
        expect(button).toBeDefined();

        await c.api("/api/live/act", { kind: "click", ref: button!.ref });

        const handback = await c.api<{ ok: boolean; captured: number }>("/api/live/handback", {
          resumeAtStepId: "s3",
          note: "clicked the relabelled search button by hand",
        });
        expect(handback.ok).toBe(true);
        expect(handback.captured).toBeGreaterThan(0);

        const resolution = await c.handedBack;
        // Captured in the automation's vocabulary — role and accessible name,
        // not a selector — which is what makes promotion to a patch possible.
        expect(resolution.capturedActions.some((a) => a.name === "Find Member")).toBe(true);
        expect(resolution.resumeAtStepId).toBe("s3");
        expect(h.control.owner).toBe("automation");

        const resumed = await h.run({ resumeAtStepId: "s3" });
        expect(resumed.status).toBe("success");
        if (resumed.status === "success") {
          expect(resumed.outputs.savingsBalance).toMatch(/^\$[\d,]+\.\d{2}$/);
        }

        // The human's work is in the run record, attributed to the operator.
        const humanRecords = h.logRecords().filter((r) => r.leaseOwner === "operator");
        expect(humanRecords.length).toBeGreaterThan(0);
        expect(humanRecords.some((r) => String(r.action).startsWith("human:"))).toBe(true);
      } finally {
        await c.close();
      }
    } finally {
      await h.close();
    }
  }, 90_000);

  it("persists the resolution before returning the lease", async () => {
    const h = await harness(partiallyDriftedCapability());
    try {
      const escalated = await h.run();
      if (escalated.status !== "escalated") throw new Error("expected an escalation");

      const c = await attachConsole(h, escalated.interventionId);
      try {
        await c.api("/api/live/take", {});
        await c.api("/api/live/handback", { resumeAtStepId: VERIFY_ONLY, note: "done by hand" });

        const stored = c.queue.get(escalated.interventionId)!;
        expect(stored.status).toBe("resolved");
        expect(stored.resolution?.resumeAtStepId).toBe(VERIFY_ONLY);
        expect(stored.resolution?.note).toBe("done by hand");
      } finally {
        await c.close();
      }
    } finally {
      await h.close();
    }
  }, 60_000);

  it("refuses to dispatch for a console that has not claimed control", async () => {
    const h = await harness(partiallyDriftedCapability());
    try {
      const escalated = await h.run();
      if (escalated.status !== "escalated") throw new Error("expected an escalation");
      const c = await attachConsole(h, escalated.interventionId);
      try {
        // The executor released the lease, but nobody has claimed it through
        // this console. "Nobody is driving" must not be mistaken for "I am".
        const refused = await c.raw("/api/live/act", { kind: "click", ref: "e1" });
        expect(refused.status).toBe(409);
        expect(c.queue.get(escalated.interventionId)!.status).toBe("open");
      } finally {
        await c.close();
      }
    } finally {
      await h.close();
    }
  }, 60_000);
});

/* --------------------------------------------------------------- resume ---- */

describe("resuming", () => {
  it("continues from the live page instead of re-entering the app", async () => {
    const h = await harness(partiallyDriftedCapability());
    try {
      const escalated = await h.run();
      if (escalated.status !== "escalated") throw new Error("expected an escalation");

      const c = await attachConsole(h, escalated.interventionId);
      await c.api("/api/live/take", {});
      const snap = await c.api<{ elements: { ref: string; name: string }[] }>(
        "/api/live/snapshot",
      );
      await c.api("/api/live/act", {
        kind: "click",
        ref: snap.elements.find((e) => e.name === "Find Member")!.ref,
      });
      await c.api("/api/live/handback", { resumeAtStepId: "s3" });
      await c.close();

      const resumed = await h.run({ resumeAtStepId: "s3" });
      expect(resumed.status).toBe("success");
      // Proof it did not restart: s1 and s2 are absent from the resumed run's
      // telemetry. A resume that navigated home would have had to redo them.
      expect(resumed.telemetry.map((t) => t.stepId)).toEqual(["s3"]);
      // And the entry snapshot is labelled as a resume, not an entry.
      expect(resumed.evidence.snapshots.some((s) => s.includes("000-resume"))).toBe(true);
    } finally {
      await h.close();
    }
  }, 90_000);

  it("rejects an unknown resume point rather than silently starting over", async () => {
    const h = await harness(partiallyDriftedCapability());
    try {
      await expect(h.run({ resumeAtStepId: "s99" })).rejects.toThrow(InputValidationError);
      // Named the real steps, so the operator can pick one.
      await expect(h.run({ resumeAtStepId: "s99" })).rejects.toThrow(/s1, s2, s3/);
    } finally {
      await h.close();
    }
  }, 60_000);
});
