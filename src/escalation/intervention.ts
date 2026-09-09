/**
 * Intervention requests: the routing half of human-in-the-loop.
 *
 * File-backed, under the run's own evidence directory. A queue technology would
 * be premature here - the brief explicitly does not reward building scaling
 * infrastructure - but the SHAPE is the shape a real queue would carry, and the
 * console reads it exactly as a worker would read a job.
 *
 * What an intervention must carry is the interesting part: enough for a human
 * who was not watching to act without asking anyone. Which capability, which
 * step and what it was trying to do, why we stopped, what the screen looked
 * like, and the token that resumes the run.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const CapturedActionSchema = z.object({
  at: z.string(),
  kind: z.string(),
  /** Normalized description of what the human did, values already redacted. */
  describe: z.string(),
  role: z.string().optional(),
  name: z.string().optional(),
  framePath: z.array(z.string()).default([]),
  url: z.string().optional(),
});
export type CapturedAction = z.infer<typeof CapturedActionSchema>;

export const InterventionSchema = z.object({
  interventionId: z.string(),
  runId: z.string(),
  capability: z.string(),
  goal: z.string(),
  stepId: z.string(),
  stepIntent: z.string(),
  reason: z.string(),
  classification: z.string(),
  createdAt: z.string(),
  /** The whole flow, so the operator can see where they are in it and say
   *  where the automation should pick up. Without this the console would be
   *  asking a human to guess a step id. */
  flow: z.array(z.object({ id: z.string(), intent: z.string(), risk: z.string() })).default([]),
  /** Relative to the run directory. */
  snapshotPath: z.string().optional(),
  screenshotPath: z.string().optional(),
  /** Presented to the operator so they know what the automation could see. */
  visibleText: z.string().optional(),
  resumeToken: z.string(),
  status: z.enum(["open", "operator_control", "resolved", "abandoned"]).default("open"),
  resolution: z
    .object({
      resolvedAt: z.string(),
      note: z.string().default(""),
      /** Operator may say the flow has moved on; replay re-verifies regardless. */
      resumeAtStepId: z.string().optional(),
      capturedActions: z.array(CapturedActionSchema).default([]),
    })
    .optional(),
});
export type Intervention = z.infer<typeof InterventionSchema>;

export class InterventionQueue {
  readonly dir: string;

  constructor(runDir: string) {
    this.dir = join(runDir, "interventions");
    mkdirSync(this.dir, { recursive: true });
  }

  open(
    request: Omit<Intervention, "interventionId" | "createdAt" | "resumeToken" | "status">,
  ): Intervention {
    const intervention: Intervention = InterventionSchema.parse({
      ...request,
      interventionId: `int-${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      resumeToken: randomUUID(),
      status: "open",
    });
    this.write(intervention);
    return intervention;
  }

  get(id: string): Intervention | undefined {
    const path = join(this.dir, `${id}.json`);
    if (!existsSync(path)) return undefined;
    return InterventionSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  list(): Intervention[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => InterventionSchema.parse(JSON.parse(readFileSync(join(this.dir, f), "utf8"))))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  write(intervention: Intervention): void {
    writeFileSync(
      join(this.dir, `${intervention.interventionId}.json`),
      JSON.stringify(intervention, null, 2) + "\n",
    );
  }
}

/** Every intervention across every run - what the console lists. */
export function listAllInterventions(
  runsRoot: string,
): { runDir: string; intervention: Intervention }[] {
  if (!existsSync(runsRoot)) return [];
  const out: { runDir: string; intervention: Intervention }[] = [];
  for (const runId of readdirSync(runsRoot)) {
    const runDir = join(runsRoot, runId);
    const intDir = join(runDir, "interventions");
    if (!existsSync(intDir)) continue;
    for (const f of readdirSync(intDir).filter((x) => x.endsWith(".json"))) {
      try {
        out.push({
          runDir,
          intervention: InterventionSchema.parse(JSON.parse(readFileSync(join(intDir, f), "utf8"))),
        });
      } catch {
        // A malformed intervention should not blank the console.
      }
    }
  }
  return out.sort((a, b) => b.intervention.createdAt.localeCompare(a.intervention.createdAt));
}
