/**
 * The control lease.
 *
 * There is exactly one authoritative answer to "who is in control of this
 * session right now", it is persisted with the run, and both the discovery loop
 * and the replay executor must hold it to dispatch anything. The check itself
 * lives in PolicyGate, so control and policy are enforced at the same choke
 * point rather than in two places that can disagree.
 *
 * Persisting it matters for a reason that is easy to miss: the operator console
 * is a separate process. A lease held in memory would let the console believe
 * it has control while the automation believes the same thing, and both would
 * drive the same live browser.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type LeaseOwner = "automation" | "operator";

export interface Lease {
  readonly leaseId: string;
  readonly owner: LeaseOwner;
  readonly acquiredAt: string;
  readonly reason: string;
  /** Set while an intervention is open, so the console knows what it is for. */
  readonly interventionId?: string;
}

export class LeaseConflict extends Error {}

export class SessionControl {
  private current: Lease;

  constructor(
    private readonly path: string,
    initialReason = "run started",
  ) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      this.current = JSON.parse(readFileSync(path, "utf8")) as Lease;
    } else {
      this.current = {
        leaseId: randomUUID(),
        owner: "automation",
        acquiredAt: new Date().toISOString(),
        reason: initialReason,
      };
      this.persist();
    }
  }

  /** Always read from disk: the console is a different process. */
  get lease(): Lease {
    if (existsSync(this.path)) {
      this.current = JSON.parse(readFileSync(this.path, "utf8")) as Lease;
    }
    return this.current;
  }

  get owner(): LeaseOwner {
    return this.lease.owner;
  }

  /**
   * Hand control over. Transfers are explicit and always recorded; there is no
   * "take it if free" path, because a lease that can be silently stolen is not
   * an answer to who is in control.
   */
  transferTo(owner: LeaseOwner, reason: string, interventionId?: string): Lease {
    const next: Lease = {
      leaseId: randomUUID(),
      owner,
      acquiredAt: new Date().toISOString(),
      reason,
      interventionId,
    };
    this.current = next;
    this.persist();
    return next;
  }

  /** Assert automation still holds the lease it thinks it holds. */
  assertHeldBy(owner: LeaseOwner, leaseId?: string): void {
    const lease = this.lease;
    if (lease.owner !== owner) {
      throw new LeaseConflict(`lease is held by ${lease.owner}, not ${owner}`);
    }
    if (leaseId && lease.leaseId !== leaseId) {
      throw new LeaseConflict(
        `lease ${leaseId} is stale; current lease is ${lease.leaseId} (${lease.reason})`,
      );
    }
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify(this.current, null, 2) + "\n");
  }
}
