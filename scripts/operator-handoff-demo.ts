/**
 * Reproducible operator handoff.
 *
 * This is an OPERATOR CLIENT, not a mock of the handoff. It speaks exactly the
 * HTTP API the console's own page speaks - take control, read the live page,
 * act on it, hand back - so what runs here is the same control transfer a human
 * performs by clicking. The only thing being substituted is the pair of hands.
 *
 * Why it exists: the escalation evidence has to be regenerable by a grader on a
 * clean clone, and "now click these three buttons within 30 seconds" is not a
 * demo path. Open the console URL it prints and you can do it by hand instead.
 *
 *   npx tsx scripts/operator-handoff-demo.ts
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";

const TARGET_CONTROL = "Commit Sub-Account";

/** Ask the OS for a port nobody is using, rather than hoping 4100 is free. A
 *  console abandoned by an earlier run holds its port, and this script is meant
 *  to be re-runnable without cleanup. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

let CONSOLE = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CONSOLE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function waitForConsole(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await api<{ leaseOwner: string }>("/api/live/state");
      // `awaiting_operator` is the signal: automation has escalated and let go
      // of the session, and nobody has claimed it. Waiting for `operator`
      // instead would deadlock, because THIS script is the one who makes that
      // true. Acting before it is the race the wait exists to avoid.
      if (state.leaseOwner === "awaiting_operator" || state.leaseOwner === "operator") return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error("the replay never escalated into a live console");
}

async function main(): Promise<void> {
  const port = Number(process.env.OPERATOR_PORT ?? (await freePort()));
  CONSOLE = `http://127.0.0.1:${port}`;

  const args = [
    "src/cli.ts",
    "replay",
    "--console-port",
    String(port),
    "--capability",
    "member.open_subaccount",
    "--tenant",
    "summit-fcu",
    "--input",
    "memberId=10042",
    "--input",
    "nickname=Vacation",
    "--input",
    "initialDeposit=250.00",
    "--input",
    "accountKind=Certificate",
    "--allow-writes",
    "--attended",
  ];

  console.log(`[operator-demo] starting: cua ${args.slice(1).join(" ")}\n`);
  const child = spawn("npx", ["tsx", ...args], { stdio: ["ignore", "inherit", "inherit"] });
  const exited = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 0)));

  await waitForConsole();
  console.log(`\n[operator-demo] the run escalated and released the session - taking control`);
  await api("/api/live/take", { method: "POST" });

  const snapshot = await api<{
    url: string;
    elements: { ref: string; role: string; name: string }[];
  }>("/api/live/snapshot");
  const button = snapshot.elements.find((e) => e.name === TARGET_CONTROL);
  if (!button) {
    throw new Error(
      `no "${TARGET_CONTROL}" control on the live page; saw: ${snapshot.elements.map((e) => e.name).join(", ")}`,
    );
  }

  console.log(`[operator-demo] reviewed the request, clicking "${button.name}" by hand`);
  await api("/api/live/act", {
    method: "POST",
    body: JSON.stringify({ kind: "click", ref: button.ref }),
  });

  console.log(`[operator-demo] handing control back, flow is complete\n`);
  await api("/api/live/handback", {
    method: "POST",
    body: JSON.stringify({
      resumeAtStepId: "$verify",
      note: "Reviewed the sub-account request against the member record and committed it manually. Automation may verify and finish.",
    }),
  });

  process.exit(await exited);
}

main().catch((err: unknown) => {
  console.error(`\n[operator-demo] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
