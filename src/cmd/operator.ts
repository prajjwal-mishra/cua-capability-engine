/**
 * `cua operator` — the standalone console.
 *
 * Triage only: it lists every intervention any run has raised and shows the
 * full context each one carries. It cannot transfer control, because there is
 * no live session in this process to transfer — and pretending otherwise would
 * be exactly the "TODO in a costume" this is meant not to be.
 *
 * Same-session takeover happens when the console is ATTACHED to a paused run,
 * which `cua replay --attended` does automatically on escalation.
 */

import { join } from "node:path";
import type { Args } from "../cli-args.js";
import { startOperatorConsole } from "../escalation/operator-console/server.js";
import { listAllInterventions } from "../escalation/intervention.js";

export async function operatorCommand(args: Args): Promise<void> {
  const port = Number(args.flags.port ?? process.env.OPERATOR_PORT ?? 4100);
  const runsRoot = join(process.cwd(), "runs");

  const open = listAllInterventions(runsRoot).filter((x) => x.intervention.status === "open");
  const console_ = await startOperatorConsole({ port, runsRoot });

  console.log(`operator desk:    ${console_.url}`);
  console.log(`interventions:    ${listAllInterventions(runsRoot).length} total, ${open.length} open`);
  console.log(
    `\nThis console is standalone, so it can review and resolve requests but not take control of a\n` +
      `browser. For same-session takeover, run:\n\n` +
      `  pnpm cua replay --capability <id> --input k=v --attended\n\n` +
      `which escalates into a console attached to the paused run. Ctrl-C to stop.`,
  );

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      void console_.close().then(resolve);
    });
  });
}
