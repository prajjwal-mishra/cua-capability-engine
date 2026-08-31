/**
 * `cua replay` — the production execution path. No model, no API key, no
 * network beyond the target app.
 */

import { chromium } from "playwright";
import { join } from "node:path";
import type { Args } from "../cli-args.js";
import { WebSurface } from "../surface/web.surface.js";
import { GuardedSurface, PolicyGate } from "../policy/gate.js";
import { loadAllowlist } from "../policy/allowlist.js";
import { Redactor } from "../policy/redact.js";
import { SessionControl } from "../escalation/control.js";
import { RunLog } from "../obs/log.js";
import { EvidenceWriter } from "../obs/evidence.js";
import { ArtifactStore } from "../artifact/store.js";
import { replayCapability } from "../replay/executor.js";
import { exitCodeFor, summarize, type ReplayResult } from "../replay/result.js";
import { newRunId } from "../obs/run-id.js";

export async function replayCommand(args: Args): Promise<void> {
  const ref = String(args.flags.capability ?? "");
  if (!ref) throw new Error("replay requires --capability <id>[@<version>]");

  const tenant = args.flags.tenant ? String(args.flags.tenant) : undefined;
  const allowWrites = args.flags["allow-writes"] === true;
  const stability = Number(args.flags.stability ?? 1);
  const inject = args.flags.inject ? String(args.flags.inject) : undefined;
  const injectCount = Number(args.flags["inject-count"] ?? 1);
  // Which request the fault lands on. Without this the fault hits whichever
  // iframe the shell loads first, which is not where the flow is — the demo
  // would be showing a nav frame failing, not a recovery mid-capability.
  const injectPath = String(args.flags["inject-path"] ?? "/frame/member");

  const store = new ArtifactStore();
  const { artifact, overlay } = store.resolve(ref, tenant);

  console.log(
    `capability: ${artifact.capabilityId}@${artifact.version}  (${artifact.lifecycle.state})`,
  );
  if (overlay) console.log(`overlay:    ${overlay.overlayId} for tenant ${overlay.tenant}`);
  console.log(`inputs:     ${JSON.stringify(args.inputs)}`);

  const allowlist = loadAllowlist(join(process.cwd(), artifact.policy.allowlistRef));
  const headless = process.env.HEADLESS === "1";
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

      const runId = newRunId(stability > 1 ? `stability-${run + 1}` : "replay");
      const redactor = new Redactor();
      const evidence = new EvidenceWriter(join(process.cwd(), "runs"), runId, redactor);
      const log = new RunLog(evidence.logPath, runId, redactor);
      const control = new SessionControl(join(evidence.dir, "lease.json"), "replay started");

      const page = await (
        await browser.newContext({ viewport: { width: 1280, height: 900 } })
      ).newPage();
      const gate = new PolicyGate();
      const surface = new GuardedSurface(new WebSurface(page), {
        gate,
        context: () => ({
          mode: "replay",
          allowlist,
          allowWrites,
          artifactApproved: artifact.lifecycle.state === "approved",
          leaseOwner: control.owner,
        }),
        declaredRisk: () => undefined,
      });

      const result = await replayCapability(artifact, surface, control, log, evidence, {
        inputs: args.inputs,
        allowWrites,
        tenant,
        noEscalate: stability > 1,
      });
      results.push(result);

      if (stability === 1) {
        console.log(`\n${summarize(result)}`);
        printTelemetry(result);
        console.log(`\nevidence: ${evidence.dir}`);
        console.log(`policy checks: ${gate.checks}`);
      } else {
        console.log(`  run ${run + 1}/${stability}: ${result.status}`);
      }

      store.recordRun(`${artifact.capabilityId}@${artifact.version}`, result.status === "success");
      await page.context().close();
    }
  } finally {
    await browser.close();
  }

  if (stability > 1) {
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

  process.exit(exitCodeFor(results[results.length - 1]!));
}

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
