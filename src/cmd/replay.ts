/**
 * `cua replay` — the production execution path. No model, no API key, no
 * network beyond the target app.
 *
 * This file also owns the attended path: when a replay escalates and the caller
 * passed --attended, the SAME browser context is handed to an operator console
 * and the run waits. That wiring lives here rather than in the executor on
 * purpose — the executor's job ends at "I stopped safely, here is the resume
 * token". Who picks that token up, and whether a human is even available, is a
 * deployment question; in production the answer is a queue worker, not a flag.
 */

import { chromium } from "playwright";
import { join } from "node:path";
import type { Args } from "../cli-args.js";
import { loadAllowlist } from "../policy/allowlist.js";
import { InterventionQueue } from "../escalation/intervention.js";
import { startOperatorConsole, type Handback } from "../escalation/operator-console/server.js";
import { ArtifactStore } from "../artifact/store.js";
import { replayCapability, type ReplayOptions } from "../replay/executor.js";
import { openSession, type Session } from "../replay/session.js";
import {
  exitCodeFor,
  stabilitySignal,
  summarize,
  type ReplayResult,
} from "../replay/result.js";
import type { CapabilityArtifact } from "../artifact/schema.js";

/** How many times one run may bounce between automation and a human before we
 *  stop. A flow needing a fourth handoff does not have a capability yet. */
const MAX_HANDOFFS = 3;

export async function replayCommand(args: Args): Promise<void> {
  const ref = String(args.flags.capability ?? "");
  if (!ref) throw new Error("replay requires --capability <id>[@<version>]");

  const tenant = args.flags.tenant ? String(args.flags.tenant) : undefined;
  const allowWrites = args.flags["allow-writes"] === true;
  const stability = Number(args.flags.stability ?? 1);
  const attended = args.flags.attended === true;
  /**
   * Report a hard failure instead of queueing an intervention.
   *
   * Wanted for two situations: a stability sweep, where nobody is watching and
   * a queued request would just sit there, and demonstrating what a genuine
   * dead end looks like. Escalation is the better default precisely because it
   * does not throw away a live session — which is also why it is unhelpful when
   * what you want to see is the failure.
   */
  const noEscalate = args.flags["no-escalate"] === true || stability > 1;
  const consolePort = Number(args.flags["console-port"] ?? process.env.OPERATOR_PORT ?? 4100);
  const inject = args.flags.inject ? String(args.flags.inject) : undefined;
  const injectCount = Number(args.flags["inject-count"] ?? 1);
  // Which request the fault lands on. Without this the fault hits whichever
  // iframe the shell loads first, which is not where the flow is — the demo
  // would be showing a nav frame failing, not a recovery mid-capability.
  const injectPath = String(args.flags["inject-path"] ?? "/frame/member");

  if (attended && args.flags["no-escalate"] === true) {
    throw new Error(
      "--attended and --no-escalate contradict each other: one waits for a human, the other refuses to ask for one",
    );
  }
  if (attended && stability > 1) {
    throw new Error(
      "--attended and --stability are mutually exclusive: a stability sweep is by definition unattended",
    );
  }

  const store = new ArtifactStore();
  const { artifact, overlay } = store.resolve(ref, tenant);
  const allowlist = loadAllowlist(join(process.cwd(), artifact.policy.allowlistRef));
  const headless = process.env.HEADLESS === "1";

  console.log(
    `capability: ${artifact.capabilityId}@${artifact.version}  (${artifact.lifecycle.state})`,
  );
  if (overlay) console.log(`overlay:    ${overlay.overlayId} for tenant ${overlay.tenant}`);
  console.log(`inputs:     ${JSON.stringify(args.inputs)}`);

  const browser = await chromium.launch({ headless });
  const results: ReplayResult[] = [];

  try {
    for (let run = 0; run < stability; run++) {
      // Faults are armed OUT OF BAND, straight from the CLI rather than through
      // the surface. That is not a loophole: the automation itself is denied
      // /__control/** by the allowlist, and arming through the app's own URLs
      // would mean the replay navigated somewhere the capability never
      // recorded, which would make the demonstration meaningless.
      if (inject) await armFault(inject, injectCount, injectPath);

      const session = await openSession({
        artifact,
        allowlist,
        allowWrites,
        attended,
        label: stability > 1 ? `stability-${run + 1}` : "replay",
        headless,
        browser,
      });

      const options: ReplayOptions = {
        inputs: args.inputs,
        allowWrites,
        tenant,
        variant: args.flags.variant ? String(args.flags.variant) : undefined,
        noEscalate,
      };

      let result = await replay(session, artifact, options);

      for (let handoff = 0; attended && result.status === "escalated"; handoff++) {
        if (handoff >= MAX_HANDOFFS) {
          console.log(
            `\nstopping: ${MAX_HANDOFFS} handoffs and the run still cannot proceed unattended.`,
          );
          break;
        }
        result = await attend(session, artifact, options, {
          interventionId: result.interventionId,
          port: consolePort,
          headless,
        });
      }

      results.push(result);

      if (stability === 1) {
        console.log(`\n${summarize(result)}`);
        printTelemetry(result);
        console.log(`\nevidence: ${session.evidence.dir}`);
        console.log(`policy checks: ${session.gate.checks}`);
      } else {
        console.log(`  run ${run + 1}/${stability}: ${result.status}`);
      }

      // A run with a fault deliberately armed says nothing about whether the
      // capability is stable — we broke the app on purpose. Recording it would
      // let a demonstration of error handling degrade the thing being
      // demonstrated.
      //
      // A --variant override counts the same way as a tenant: both mean "aimed
      // somewhere other than where this was recorded", and neither should move
      // the headline number.
      if (!inject) {
        const signal = stabilitySignal(result);
        if (signal !== "ignore") {
          store.recordRun(
            `${artifact.capabilityId}@${artifact.version}`,
            signal === "success",
            tenant ?? (options.variant ? `variant:${options.variant}` : undefined),
          );
        }
      }
      await session.close();
    }
  } finally {
    await browser.close();
  }

  if (stability > 1) reportStability(results);

  process.exit(exitCodeFor(results[results.length - 1]!));
}

const replay = (
  session: Session,
  artifact: CapabilityArtifact,
  options: ReplayOptions,
): Promise<ReplayResult> =>
  replayCapability(
    artifact,
    session.surface,
    session.control,
    session.log,
    session.evidence,
    options,
  );

/* ------------------------------------------------------- attended handoff -- */

/** How long an attended run holds a live browser waiting for a human. Generous,
 *  because a real operator has to read the screen and think, but finite. */
const HANDOFF_TIMEOUT_MS = Number(process.env.CUA_HANDOFF_TIMEOUT_MS ?? 15 * 60_000);

/**
 * Pause, cede control, resume — on the same session.
 *
 * The console starts AFTER the executor has already moved the lease to the
 * operator, so at no point do both sides believe they may act. When the human
 * hands back, what they did is written into the run log as evidence and the
 * executor is re-entered at the step they nominated — which re-observes the
 * page and re-checks that step's precondition before touching anything.
 */
async function attend(
  session: Session,
  artifact: CapabilityArtifact,
  options: ReplayOptions,
  opts: { interventionId: string; port: number; headless: boolean },
): Promise<ReplayResult> {
  const queue = new InterventionQueue(session.evidence.dir);
  const intervention = queue.get(opts.interventionId);
  if (!intervention) throw new Error(`intervention ${opts.interventionId} is not in the queue`);

  let resolveHandback: (h: Handback) => void = () => {};
  const handedBack = new Promise<Handback>((resolve) => {
    resolveHandback = resolve;
  });

  const operatorConsole = await startOperatorConsole({
    port: opts.port,
    runsRoot: join(process.cwd(), "runs"),
    live: {
      page: session.page,
      surface: session.web,
      control: session.control,
      redactor: session.redactor,
      gate: session.gate,
      allowlist: session.allowlist,
      queue,
      intervention,
      log: session.log,
    },
    onHandback: resolveHandback,
  });

  console.log(`\n── escalated ─────────────────────────────────────────────`);
  console.log(`intervention: ${intervention.interventionId}  (${intervention.classification})`);
  console.log(`reason:       ${intervention.reason}`);
  console.log(`lease:        ${session.control.owner}`);
  console.log(`console:      ${operatorConsole.url}/i/${intervention.interventionId}`);
  console.log(
    opts.headless
      ? `The browser is headless, so drive the session from the console's element list.`
      : `The browser window IS the live session — drive it directly, or use the console.`,
  );
  console.log(`waiting for an operator to take control and hand back …`);

  // Bounded, because "wait forever" is not a behaviour a CLI should have. On
  // timeout the intervention stays queued and the operator console can still
  // pick it up later; we just stop holding a browser open for it.
  const handback = await Promise.race([
    handedBack,
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), HANDOFF_TIMEOUT_MS).unref(),
    ),
  ]);
  await operatorConsole.close();

  if (handback === "timeout") {
    console.log(
      `\nno operator took control within ${Math.round(HANDOFF_TIMEOUT_MS / 60_000)} minutes. ` +
        `Intervention ${intervention.interventionId} is still queued; triage it with:\n` +
        `  cua operator`,
    );
    return {
      status: "escalated",
      capability: `${artifact.capabilityId}@${artifact.version}`,
      interventionId: intervention.interventionId,
      reason: intervention.reason,
      resumeToken: intervention.resumeToken,
      telemetry: [],
      evidence: {
        runId: session.evidence.runId,
        dir: session.evidence.dir,
        logPath: session.evidence.logPath,
        screenshots: [],
        snapshots: [],
      },
      timing: { startedAt: new Date().toISOString(), durationMs: 0, stepsExecuted: 0 },
    };
  }

  // The human's actions are already in the run log — the console writes them at
  // handback, so they are recorded whether or not this particular caller is the
  // one waiting. Duplicating them here would double every entry in the audit
  // trail for the actions that matter most.
  const resumeAtStepId = handback.resumeAtStepId ?? intervention.stepId;
  session.log.write({
    phase: "intervention",
    stepId: intervention.stepId,
    intent: `resume after operator handoff at ${resumeAtStepId}`,
    action: "resume",
    leaseOwner: session.control.owner,
    outcome: "handed_back",
    extra: {
      interventionId: intervention.interventionId,
      note: handback.note,
      humanActions: handback.capturedActions.length,
      resumeAtStepId,
    },
  });

  console.log(`\n── resumed ───────────────────────────────────────────────`);
  console.log(`lease:        ${session.control.owner}`);
  console.log(`human did:    ${handback.capturedActions.length} action(s)`);
  for (const action of handback.capturedActions) console.log(`              ${action.describe}`);
  console.log(`resuming at:  ${resumeAtStepId}`);

  return replay(session, artifact, { ...options, resumeAtStepId });
}

/* --------------------------------------------------------------- output --- */

function printTelemetry(result: ReplayResult): void {
  if (result.telemetry.length === 0) return;
  console.log("\nstep telemetry:");
  for (const t of result.telemetry) {
    const drift = t.driftSignal ? "  ⚠ drift" : "";
    const rec =
      t.recoveriesApplied.length > 0 ? `  recovered:${t.recoveriesApplied.join(",")}` : "";
    console.log(
      `  ${t.stepId.padEnd(4)} ${String(t.resolvedBy ?? "-").padEnd(20)} ${String(t.attempts)}x  ${t.durationMs}ms${rec}${drift}`,
    );
  }
}

function reportStability(results: readonly ReplayResult[]): void {
  const successes = results.filter((r) => r.status === "success").length;
  const rate = ((successes / results.length) * 100).toFixed(1);
  console.log(`\nstability: ${successes}/${results.length} succeeded (${rate}%)`);
  const byStatus = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`breakdown: ${JSON.stringify(byStatus)}`);
  const drifted = results.flatMap((r) => r.telemetry.filter((t) => t.driftSignal));
  console.log(
    drifted.length === 0
      ? "drift:     none — every step resolved on its recorded top strategy"
      : `drift:     ${drifted.length} step(s) resolved on a lower rung: ${[...new Set(drifted.map((d) => `${d.stepId}→${d.resolvedBy}`))].join(", ")}`,
  );
}

async function armFault(mode: string, count: number, pathContains: string): Promise<void> {
  const origin = process.env.CUA_TARGET_ORIGIN ?? "http://localhost:4000";
  const res = await fetch(`${origin}/__control/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, count, pathContains }),
  });
  if (!res.ok) throw new Error(`could not arm fault '${mode}': ${await res.text()}`);
  console.log(
    `injected:   ${mode} on the next ${count} request${count === 1 ? "" : "s"} to ${pathContains}`,
  );
}
