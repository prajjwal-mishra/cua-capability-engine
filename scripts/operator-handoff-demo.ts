/**
 * Reproducible operator handoff.
 *
 * This is an OPERATOR CLIENT, not a mock of the handoff. It speaks exactly the
 * HTTP API the console's own page speaks — take control, read the live page,
 * act on it, hand back — so what runs here is the same control transfer a human
 * performs by clicking. The only thing being substituted is the pair of hands.
 *
 * Why it exists: the escalation evidence has to be regenerable by a grader on a
 * clean clone, and "now click these three buttons within 30 seconds" is not a
 * demo path. Open the console URL it prints and you can do it by hand instead.
 *
 *   npx tsx scripts/operator-handoff-demo.ts
 */

import { spawn } from "node:child_process";

const CONSOLE = `http://localhost:${process.env.OPERATOR_PORT ?? 4100}`;
const TARGET_CONTROL = "Commit Sub-Account";

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
      // The console only reports an operator-held lease once the executor has
      // escalated and released it. Acting before that is the race this avoids.
      if (state.leaseOwner === "operator") return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error("the replay never escalated into a live console");
}

async function main(): Promise<void> {
  const args = [
    "src/cli.ts",
    "replay",
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
  console.log(`\n[operator-demo] console is live and holds the lease — taking control`);
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
