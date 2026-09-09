/**
 * One place that assembles a replay session.
 *
 * Both entry points into the production path — the CLI and the agent-facing
 * catalog — go through here, so there is exactly one answer to "how is a
 * replay wired up", and in particular exactly one place where the executor is
 * handed its surface. That matters more than the saved lines: if the catalog
 * assembled its own surface it could quietly assemble an UNGUARDED one, and
 * the policy choke point would have a second door.
 */

import { chromium, type Browser, type Page } from "playwright";
import { join } from "node:path";
import { WebSurface } from "../surface/web.surface.js";
import { GuardedSurface, PolicyGate } from "../policy/gate.js";
import type { Allowlist } from "../policy/allowlist.js";
import { Redactor } from "../policy/redact.js";
import { SessionControl } from "../escalation/control.js";
import { RunLog } from "../obs/log.js";
import { EvidenceWriter } from "../obs/evidence.js";
import { newRunId } from "../obs/run-id.js";
import type { CapabilityArtifact } from "../artifact/schema.js";

export interface SessionSpec {
  readonly artifact: CapabilityArtifact;
  readonly allowlist: Allowlist;
  readonly allowWrites: boolean;
  /** A human is watching and can take over. Lets a draft shadow-replay. */
  readonly attended?: boolean;
  /** Prefix for the run id, so evidence directories say what they are. */
  readonly label: string;
  readonly headless?: boolean;
  /** Reuse a browser across several sessions, as a stability sweep does. */
  readonly browser?: Browser;
}

export interface Session {
  readonly page: Page;
  /** The raw surface. The operator desk drives this after the gate has allowed
   *  the action: a human is not the automation, but they are still inside the
   *  allowlist. */
  readonly web: WebSurface;
  /** The only surface the executor ever sees. */
  readonly surface: GuardedSurface;
  readonly control: SessionControl;
  readonly log: RunLog;
  readonly evidence: EvidenceWriter;
  readonly redactor: Redactor;
  readonly gate: PolicyGate;
  readonly allowlist: Allowlist;
  readonly close: () => Promise<void>;
}

export async function openSession(spec: SessionSpec): Promise<Session> {
  const headless = spec.headless ?? process.env.HEADLESS === "1";
  const ownBrowser = spec.browser === undefined;
  const browser = spec.browser ?? (await chromium.launch({ headless }));

  const runId = newRunId(spec.label);
  const redactor = new Redactor();
  const evidence = new EvidenceWriter(join(process.cwd(), "runs"), runId, redactor);
  const log = new RunLog(evidence.logPath, runId, redactor);
  const control = new SessionControl(join(evidence.dir, "lease.json"), `${spec.label} started`);

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const gate = new PolicyGate();
  const web = new WebSurface(page);
  const surface = new GuardedSurface(web, {
    gate,
    // Read fresh at every action, so a lease handover mid-run takes effect on
    // the next dispatch rather than at the next step boundary.
    context: () => ({
      mode: "replay",
      allowlist: spec.allowlist,
      allowWrites: spec.allowWrites,
      artifactApproved: spec.artifact.lifecycle.state === "approved",
      attended: spec.attended === true,
      leaseOwner: control.owner,
    }),
  });

  return {
    page,
    web,
    surface,
    control,
    log,
    evidence,
    redactor,
    gate,
    allowlist: spec.allowlist,
    close: async () => {
      await context.close();
      if (ownBrowser) await browser.close();
    },
  };
}
