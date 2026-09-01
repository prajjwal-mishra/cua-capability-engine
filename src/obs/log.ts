/**
 * Structured run logging. One JSONL record per step, everything redacted on the
 * way in — the Redactor sits between this logger and the raw world, so there is
 * no code path that writes an unredacted value to disk.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Redactor } from "../policy/redact.js";
import type { RiskClass } from "../policy/risk.js";
import type { StrategyKind } from "../locator/descriptor.js";

import type { LeaseOwner } from "../escalation/control.js";
export type { LeaseOwner };

export interface StepLogRecord {
  readonly ts: string;
  readonly runId: string;
  readonly phase: "discovery" | "replay" | "recovery" | "intervention";
  readonly stepId: string;
  readonly intent: string;
  readonly action: string;
  readonly leaseOwner: LeaseOwner;
  /** Which rung of the locator ladder actually resolved. The drift signal. */
  readonly resolvedBy?: StrategyKind;
  readonly resolutionStatus?: "resolved" | "ambiguous" | "not_found";
  readonly descriptorIntent?: string;
  readonly policy?: { verdict: string; risk: RiskClass; code?: string; reason?: string };
  readonly waitMs?: number;
  readonly checkpoint?: { passed: boolean; describe?: string; observed?: string };
  readonly outcome?: string;
  /** The model's stated reasoning, for discovery steps. Redacted. */
  readonly rationale?: string;
  readonly error?: string;
  readonly extra?: Record<string, unknown>;
}

export class RunLog {
  private readonly records: StepLogRecord[] = [];

  constructor(
    private readonly path: string,
    private readonly runId: string,
    private readonly redactor: Redactor,
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(record: Omit<StepLogRecord, "ts" | "runId">): StepLogRecord {
    const full: StepLogRecord = {
      ts: new Date().toISOString(),
      runId: this.runId,
      ...record,
    };
    const safe = this.redactor.redactJson(full);
    this.records.push(safe);
    appendFileSync(this.path, JSON.stringify(safe) + "\n");
    return safe;
  }

  all(): readonly StepLogRecord[] {
    return this.records;
  }
}
