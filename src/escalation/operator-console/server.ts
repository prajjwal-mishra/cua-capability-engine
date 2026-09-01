/**
 * The operator console.
 *
 * Two modes, one implementation:
 *
 *   standalone  — `cua operator`. Lists intervention requests across every run
 *                 and shows their full context. Review and triage; no browser.
 *
 *   attached    — started by a replay that escalated, holding the paused run's
 *                 live page. This is where control actually transfers.
 *
 * What is real: the lease (persisted, authoritative, checked before every
 * dispatched action), the takeover happening on the SAME browser context the
 * automation was driving, the capture of what the human did, and the resume
 * that re-verifies the step's precondition rather than assuming.
 *
 * What is mocked: there is no embedded co-browsing video stream. The operator
 * sees a polled screenshot and, when the browser is headed, the real window.
 * The production design for that is in REPORT.md § Escalation & handoff.
 */

import express from "express";
import type { Page } from "playwright";
import { join } from "node:path";
import type { WebSurface } from "../../surface/web.surface.js";
import type { Redactor } from "../../policy/redact.js";
import type { SessionControl } from "../control.js";
import type { RunLog } from "../../obs/log.js";
import {
  InterventionQueue,
  listAllInterventions,
  type CapturedAction,
  type Intervention,
} from "../intervention.js";
import {
  capturedActions,
  installHumanRecorder,
  resolveFramePaths,
} from "../human-recorder.js";
import { interventionView, queueView } from "./ui.js";

export interface LiveSession {
  readonly page: Page;
  readonly surface: WebSurface;
  readonly control: SessionControl;
  readonly redactor: Redactor;
  readonly queue: InterventionQueue;
  readonly intervention: Intervention;
  /**
   * The run's log, so the human's actions land in the same audit trail as the
   * automation's.
   *
   * A handoff where the machine's steps are recorded and the human's are not
   * produces a run record that reads as if the automation did everything —
   * which is precisely backwards for the actions most worth attributing. These
   * are written here rather than by the caller so that attribution does not
   * depend on which caller attached the console.
   */
  readonly log?: RunLog;
}

export interface Handback {
  readonly capturedActions: readonly CapturedAction[];
  readonly note: string;
  /** Where the operator says automation should pick up. `undefined` means
   *  "re-run the step that stopped"; VERIFY_ONLY means "I finished the flow". */
  readonly resumeAtStepId?: string;
}

export interface ConsoleOptions {
  readonly port: number;
  readonly runsRoot: string;
  readonly live?: LiveSession;
  /** Called when the operator hands control back, before the run resumes. */
  readonly onHandback?: (handback: Handback) => void;
}

export async function startOperatorConsole(
  options: ConsoleOptions,
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());

  const live = options.live;

  /** The human's actions, with frame paths resolved. Read as often as you like. */
  const readCaptured = (session: LiveSession): Promise<CapturedAction[]> =>
    resolveFramePaths(session.page, (frame) => session.surface.framePathOf(frame));

  /* ------------------------------------------------------------- views -- */

  app.get("/", (_req, res) => {
    const items = listAllInterventions(options.runsRoot).map((x) => x.intervention);
    res.send(queueView(items, live !== undefined));
  });

  app.get("/i/:id", (req, res) => {
    const found = listAllInterventions(options.runsRoot).find(
      (x) => x.intervention.interventionId === req.params.id,
    );
    if (!found) {
      res.status(404).send("no such intervention");
      return;
    }
    const isLive = live?.intervention.interventionId === req.params.id;
    res.send(interventionView(found.intervention, isLive));
  });

  app.get("/api/interventions", (_req, res) => {
    res.json(listAllInterventions(options.runsRoot).map((x) => x.intervention));
  });

  /* -------------------------------------------------------- live session -- */

  const requireLive = (res: express.Response): LiveSession | undefined => {
    if (!live) {
      res.status(409).json({ error: "no live session attached to this console" });
      return undefined;
    }
    return live;
  };

  /**
   * A console may only drive a session it has explicitly claimed.
   *
   * The lease reading `awaiting_operator` is not enough. That state means
   * automation has stepped back, which is not the same as a human having
   * arrived — and acting on the weaker signal would dispatch clicks into a live
   * banking session with no recorder installed and nothing attributing them to
   * anyone.
   */
  const requireControl = (res: express.Response): LiveSession | undefined => {
    const session = requireLive(res);
    if (!session) return undefined;
    if (session.control.owner !== "operator") {
      res.status(409).json({
        error: "take control before acting on the session",
        leaseOwner: session.control.owner,
      });
      return undefined;
    }
    return session;
  };

  app.get("/api/live/state", (_req, res) => {
    if (!live) {
      res.json({ leaseOwner: "none", status: "none", captured: [] });
      return;
    }
    const current = live.queue.get(live.intervention.interventionId);
    res.json({
      leaseOwner: live.control.owner,
      leaseReason: live.control.lease.reason,
      status: current?.status ?? live.intervention.status,
      captured: capturedActions(live.page),
    });
  });

  app.get("/api/live/screenshot", async (_req, res) => {
    const session = requireLive(res);
    if (!session) return;
    try {
      // Straight through the surface's masking path: sensitive regions are
      // painted out before the image is encoded, so no unmasked frame of a
      // member's account ever reaches the console.
      const snapshot = await session.surface.observe();
      const { sensitiveBounds } = session.redactor.redactSnapshot(snapshot);
      const png = await session.surface.screenshot(sensitiveBounds);
      res.type("png").send(png);
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/live/snapshot", async (_req, res) => {
    const session = requireLive(res);
    if (!session) return;
    const snapshot = await session.surface.observe();
    const { snapshot: clean } = session.redactor.redactSnapshot(snapshot);
    res.json({
      url: clean.page.url,
      elements: clean.elements
        .filter((e) =>
          ["textbox", "button", "link", "combobox", "checkbox", "radio"].includes(e.role),
        )
        .map((e) => ({ ref: e.ref, role: e.role, name: e.name, framePath: e.framePath })),
    });
  });

  /**
   * Take control. The lease moves to the operator FIRST, and only then is the
   * recorder installed — the automation is checking that lease before every
   * action it dispatches, so there is no window in which both sides believe
   * they may act.
   */
  app.post("/api/live/take", async (_req, res) => {
    const session = requireLive(res);
    if (!session) return;
    // You cannot seize a session automation is still driving. Interrupting a
    // run mid-action is what the intervention queue is for.
    if (session.control.owner === "automation") {
      res.status(409).json({ error: "automation is driving this session; it has not escalated" });
      return;
    }
    session.control.transferTo(
      "operator",
      `operator took control for ${session.intervention.interventionId}`,
      session.intervention.interventionId,
    );
    const current = session.queue.get(session.intervention.interventionId);
    if (current) session.queue.write({ ...current, status: "operator_control" });

    await installHumanRecorder(session.page);
    res.json({ ok: true, leaseOwner: session.control.owner });
  });

  /** Manual action injection, so takeover is real on a headless browser too. */
  app.post("/api/live/act", async (req, res) => {
    const session = requireControl(res);
    if (!session) return;
    const { kind, ref, text } = req.body as { kind: string; ref: string; text?: string };
    try {
      // Dispatched on the RAW surface: the policy gate governs what the
      // automation may do, and a human operator is not the automation. The
      // lease is what authorises this, and it is checked above.
      const result =
        kind === "type"
          ? await session.surface.act({ kind: "type", ref, text: text ?? "" })
          : await session.surface.act({ kind: "click", ref });
      res.json({
        ok: result.ok,
        error: result.error,
        captured: capturedActions(session.page).length,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Hand back: record what happened, return the lease, let the run resume. */
  app.post("/api/live/handback", async (req, res) => {
    // Handing back a session you never took would resolve someone else's
    // intervention and restart the automation under them.
    const session = requireControl(res);
    if (!session) return;

    const captured = await readCaptured(session);

    const body = (req.body ?? {}) as { note?: string; resumeAtStepId?: string };
    const note = String(body.note ?? "");
    const resumeAtStepId = body.resumeAtStepId ? String(body.resumeAtStepId) : undefined;

    for (const action of captured) {
      session.log?.write({
        phase: "intervention",
        stepId: session.intervention.stepId,
        intent: session.intervention.stepIntent,
        action: `human:${action.kind}`,
        leaseOwner: "operator",
        outcome: action.describe,
        extra: {
          interventionId: session.intervention.interventionId,
          role: action.role,
          name: action.name,
          framePath: action.framePath,
          url: action.url,
          at: action.at,
        },
      });
    }
    session.log?.write({
      phase: "intervention",
      stepId: session.intervention.stepId,
      intent: session.intervention.stepIntent,
      action: "handback",
      leaseOwner: "operator",
      outcome: `operator returned control after ${captured.length} action(s)`,
      extra: { interventionId: session.intervention.interventionId, note, resumeAtStepId },
    });

    const current = session.queue.get(session.intervention.interventionId);
    if (current) {
      session.queue.write({
        ...current,
        status: "resolved",
        resolution: {
          resolvedAt: new Date().toISOString(),
          note,
          resumeAtStepId,
          capturedActions: captured,
        },
      });
    }

    // The lease returns to automation only after the resolution is durable, so
    // a crash between the two leaves the run stopped rather than running blind.
    session.control.transferTo("automation", "operator handed control back");
    options.onHandback?.({ capturedActions: captured, note, resumeAtStepId });

    res.json({ ok: true, status: "resolved", captured: captured.length, resumeAtStepId });
  });

  /* ------------------------------------------------------------- listen -- */

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(options.port, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;

  return {
    url: `http://localhost:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const DEFAULT_RUNS_ROOT = join(process.cwd(), "runs");
