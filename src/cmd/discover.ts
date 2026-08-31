/**
 * `cua discover` — the one command that puts a model in the loop.
 *
 * It fails fast and loudly when there is no working model, rather than
 * degrading into something that looks like a run but isn't. A discovery run
 * that cannot happen must be reported, not simulated.
 */

import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Args } from "../cli.js";
import { WebSurface } from "../surface/web.surface.js";
import { GuardedSurface, PolicyGate } from "../policy/gate.js";
import { loadAllowlist } from "../policy/allowlist.js";
import { Redactor } from "../policy/redact.js";
import { SessionControl } from "../escalation/control.js";
import { RunLog } from "../obs/log.js";
import { EvidenceWriter } from "../obs/evidence.js";
import { LlmClient, llmConfigFromEnv } from "../discovery/llm.js";
import { runDiscovery } from "../discovery/loop.js";
import { compileTrace, newRunId, RecoveryPackSchema } from "../recorder/compile.js";
import { ArtifactStore } from "../artifact/store.js";
import type { GoalSpec } from "../discovery/prompts.js";

const INPUT_META: Record<
  string,
  {
    description: string;
    sensitivity: "public" | "internal" | "pii" | "secret";
    jsonSchema: Record<string, unknown>;
  }
> = {
  memberId: {
    description: "The member's identifier as printed on their statement.",
    sensitivity: "internal",
    jsonSchema: { type: "string", pattern: "^[0-9]{5}$" },
  },
  nickname: {
    description: "A short label for the new sub-account.",
    sensitivity: "internal",
    jsonSchema: { type: "string", minLength: 3, maxLength: 40 },
  },
  initialDeposit: {
    description: "Opening deposit amount, in dollars.",
    sensitivity: "internal",
    jsonSchema: { type: "string", pattern: "^[0-9]+(\\.[0-9]{1,2})?$" },
  },
  accountKind: {
    description: "Product type for the new sub-account.",
    sensitivity: "internal",
    jsonSchema: { type: "string", enum: ["Savings", "Certificate"] },
  },
};

export async function discoverCommand(args: Args): Promise<void> {
  const goalText = String(args.flags.goal ?? "");
  const target = String(args.flags.target ?? "http://localhost:4000");
  const tenant = String(args.flags.tenant ?? "demo-cu");
  const variant = args.flags.variant ? String(args.flags.variant) : undefined;
  const capabilityId = String(args.flags.capability ?? "member.savings_balance");
  const version = String(args.flags.version ?? "1.0.0");
  const allowWrites = args.flags["allow-writes"] === true;

  if (!goalText) throw new Error("discover requires --goal");

  // Fail before launching a browser if the model is unreachable.
  const llm = new LlmClient(llmConfigFromEnv());
  process.stdout.write(`checking model ${llm.model} … `);
  const health = await llm.healthCheck();
  if (!health.ok) {
    throw new Error(
      `the configured LLM is not reachable.\n\n  model:  ${llm.model}\n  detail: ${health.detail}\n\n` +
        `Discovery is the one part of this system that cannot be faked, so it stops here rather than\n` +
        `producing a plausible-looking run. Point CUA_LLM_BASE_URL / _API_KEY / _MODEL at any working\n` +
        `OpenAI-compatible endpoint and re-run. Replay, catalog and tests do not need one.`,
    );
  }
  console.log(`ok (${health.detail})`);

  const allowlistRef = String(args.flags.allowlist ?? "config/allowlist.demo-cu.json");
  const allowlist = loadAllowlist(join(process.cwd(), allowlistRef));
  const runId = newRunId("discover");
  const redactor = new Redactor();
  const evidence = new EvidenceWriter(join(process.cwd(), "runs"), runId, redactor);
  const log = new RunLog(evidence.logPath, runId, redactor);
  const control = new SessionControl(join(evidence.dir, "lease.json"), "discovery run started");

  const paramValues = { ...args.inputs };
  const goal: GoalSpec = {
    goal: goalText,
    targetUrl: variant ? `${target}/?variant=${variant}` : target,
    tenant,
    variant,
    params: Object.keys(paramValues).map((name) => ({
      name,
      description: INPUT_META[name]?.description ?? `Input parameter ${name}.`,
      sensitivity: INPUT_META[name]?.sensitivity ?? "internal",
    })),
  };

  const headless = process.env.HEADLESS === "1";
  const browser = await chromium.launch({ headless });
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  const gate = new PolicyGate();
  const surface = new GuardedSurface(new WebSurface(page), {
    gate,
    context: () => ({
      mode: "discovery",
      allowlist,
      allowWrites,
      leaseOwner: control.owner,
    }),
  });

  try {
    console.log(`\ngoal:    ${goalText}`);
    console.log(`target:  ${goal.targetUrl}`);
    console.log(`run:     ${runId}\n`);

    const trace = await runDiscovery(surface, llm, goal, log, evidence, redactor, {
      paramValues,
      maxSteps: Number(args.flags["max-steps"] ?? 24),
    });

    console.log(`\nstatus:  ${trace.status}  (${trace.stopReason})`);
    console.log(`steps:   ${trace.steps.length}`);
    console.log(`outputs: ${trace.outputs.map((o) => o.name).join(", ") || "none"}`);
    console.log(`policy checks: ${gate.checks}`);

    evidence.saveJson("trace-summary.json", {
      runId,
      status: trace.status,
      stopReason: trace.stopReason,
      model: trace.model,
      goal: trace.goal,
      steps: trace.steps.map((s) => ({
        index: s.index,
        tool: s.tool,
        rationale: s.rationale,
        action: s.action,
        target: s.element
          ? { role: s.element.role, name: s.element.name, framePath: s.element.framePath }
          : undefined,
        paramBinding: s.paramBinding,
      })),
      outputs: trace.outputs.map((o) => ({ name: o.name, from: o.element.name, parse: o.parse })),
      outcomes: trace.outcomes.map((o) => ({ code: o.code, severity: o.severity })),
      redaction: redactor.report(),
    });

    if (trace.status !== "success") {
      console.log(`\nno capability compiled: the run did not reach the goal.`);
      console.log(`evidence: ${evidence.dir}`);
      return;
    }

    const packPath = join(process.cwd(), `config/recovery-pack.${vendorProductFor(tenant)}.json`);
    const recoveryPack = existsSync(packPath)
      ? RecoveryPackSchema.parse(JSON.parse(readFileSync(packPath, "utf8")))
      : undefined;

    const artifact = compileTrace(trace, {
      capabilityId,
      version,
      name: String(args.flags.name ?? goalText.slice(0, 60)),
      description: goalText,
      vendorProduct: vendorProductFor(tenant),
      appId: "legacy-cu",
      allowlist,
      allowlistRef,
      inputSpecs: Object.keys(paramValues).map((name) => ({
        name,
        description: INPUT_META[name]?.description ?? `Input parameter ${name}.`,
        sensitivity: INPUT_META[name]?.sensitivity ?? "internal",
        jsonSchema: INPUT_META[name]?.jsonSchema ?? { type: "string" },
      })),
      paramValues,
      recoveryPack,
      gitSha: gitSha(),
      evidenceRef: `evidence/discovery/${runId}`,
    });

    const path = new ArtifactStore().save(artifact);
    evidence.saveJson("capability.json", artifact);

    console.log(`\ncompiled ${artifact.capabilityId}@${artifact.version} → ${path}`);
    console.log(`  steps:        ${artifact.steps.length}`);
    console.log(`  inputs:       ${artifact.inputs.map((i) => i.name).join(", ") || "none"}`);
    console.log(`  outputs:      ${artifact.outputs.map((o) => o.name).join(", ") || "none"}`);
    console.log(
      `  outcomes:     ${artifact.knownOutcomes.length} (${recoveryPack ? "incl. reviewed pack" : "discovered only"})`,
    );
    console.log(`  recoveries:   ${artifact.recoveries.length}`);
    console.log(`  lifecycle:    ${artifact.lifecycle.state}`);
    console.log(`\nevidence: ${evidence.dir}`);
  } finally {
    await browser.close();
  }
}

/** In the real world this is a property of the tenant record. */
function vendorProductFor(_tenant: string): string {
  return "corevantage-backoffice";
}

function gitSha(): string | undefined {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}
