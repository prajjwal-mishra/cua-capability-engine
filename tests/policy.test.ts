/**
 * Guardrail tests. The one that matters most is the last block: proof that no
 * action path reaches the surface without the gate having been consulted.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllowlist, routeMatches, type Allowlist } from "../src/policy/allowlist.js";
import {
  GuardedSurface,
  PolicyGate,
  PolicyViolation,
  ApprovalRequired,
} from "../src/policy/gate.js";
import { classifyAction, effectiveRisk } from "../src/policy/risk.js";
import { Redactor } from "../src/policy/redact.js";
import { EvidenceWriter } from "../src/obs/evidence.js";
import type {
  ActionResult,
  Surface,
  SurfaceAction,
  SurfaceCapabilities,
  UIElement,
  UISnapshot,
} from "../src/surface/types.js";

const allowlist: Allowlist = loadAllowlist(join(process.cwd(), "config/allowlist.demo-cu.json"));
const snapshot: UISnapshot = JSON.parse(
  readFileSync(join(process.cwd(), "tests/fixtures/snapshots/search-variant-a.json"), "utf8"),
);

const el = (role: string, name: string): UIElement => {
  const found = snapshot.elements.find((e) => e.role === role && e.name === name);
  if (!found) throw new Error(`fixture missing ${role} ${name}`);
  return found;
};

const ctx = (over: Partial<Parameters<PolicyGate["check"]>[1]> = {}) => ({
  mode: "replay" as const,
  allowlist,
  currentUrl: "http://localhost:4000/frame/search",
  allowWrites: false,
  leaseOwner: "automation" as const,
  ...over,
});

describe("allowlist route matching", () => {
  it("matches single and multi segment wildcards", () => {
    expect(routeMatches("/frame/**", "/frame/member/10042")).toBe(true);
    expect(routeMatches("/frame/*", "/frame/search")).toBe(true);
    expect(routeMatches("/frame/*", "/frame/member/10042")).toBe(false);
    expect(routeMatches("/", "/")).toBe(true);
  });
});

describe("deny by default", () => {
  const gate = new PolicyGate();

  it("refuses an origin nobody approved", () => {
    const d = gate.check({ kind: "navigate", url: "https://evil.example/x" }, ctx());
    expect(d.verdict).toBe("deny");
    if (d.verdict === "deny") expect(d.code).toBe("origin_not_allowed");
  });

  it("refuses the target app's own control plane", () => {
    // The automation must not be able to arm its own fault injections.
    const d = gate.check(
      { kind: "navigate", url: "http://localhost:4000/__control/inject" },
      ctx(),
    );
    expect(d.verdict).toBe("deny");
    if (d.verdict === "deny") expect(d.code).toBe("route_not_allowed");
  });

  it("refuses an action type not on the list", () => {
    const narrowed: Allowlist = { ...allowlist, actions: ["navigate", "read"] };
    const d = gate.check({ kind: "click", ref: "e1" }, ctx({ allowlist: narrowed }));
    expect(d.verdict).toBe("deny");
    if (d.verdict === "deny") expect(d.code).toBe("action_not_allowed");
  });

  it("refuses to type into a forbidden field regardless of risk class", () => {
    const ssn: UIElement = { ...el("textbox", "Member ID"), name: "Social Security Number" };
    const d = gate.check({ kind: "type", ref: ssn.ref, text: "x" }, ctx({ element: ssn }));
    expect(d.verdict).toBe("deny");
    if (d.verdict === "deny") expect(d.code).toBe("forbidden_field");
  });

  it("refuses to act while a human holds the lease", () => {
    const d = gate.check({ kind: "click", ref: "e1" }, ctx({ leaseOwner: "operator" }));
    expect(d.verdict).toBe("deny");
    if (d.verdict === "deny") expect(d.code).toBe("lease_not_held");
  });

  it("lets an operator who holds the lease confirm an irreversible action", () => {
    const d = gate.check(
      { kind: "click", ref: "e1" },
      ctx({
        actor: "operator",
        leaseOwner: "operator",
        allowWrites: true,
        declaredRisk: "irreversible",
      }),
    );
    expect(d.verdict).toBe("allow");
  });

  it("still refuses an operator who has not taken the session", () => {
    const d = gate.check(
      { kind: "click", ref: "e1" },
      ctx({ actor: "operator", leaseOwner: "awaiting_operator" }),
    );
    expect(d.verdict).toBe("deny");
    if (d.verdict === "deny") expect(d.code).toBe("lease_not_held");
  });

  it("does not let an operator leave the allowlist", () => {
    const d = gate.check(
      { kind: "navigate", url: "https://evil.example/x" },
      ctx({ actor: "operator", leaseOwner: "operator" }),
    );
    expect(d.verdict).toBe("deny");
    if (d.verdict === "deny") expect(d.code).toBe("origin_not_allowed");
  });

  it("does not let an operator type into a forbidden field", () => {
    const ssn: UIElement = { ...el("textbox", "Member ID"), name: "Social Security Number" };
    const d = gate.check(
      { kind: "type", ref: ssn.ref, text: "x" },
      ctx({ actor: "operator", leaseOwner: "operator", element: ssn }),
    );
    expect(d.verdict).toBe("deny");
    if (d.verdict === "deny") expect(d.code).toBe("forbidden_field");
  });
});

describe("risk classes", () => {
  const gate = new PolicyGate();

  it("treats typing as read-only - the submit carries the risk, not the keystroke", () => {
    expect(
      classifyAction(
        { kind: "type", ref: "e1", text: "10042" },
        el("textbox", "Member ID"),
        allowlist.risk,
      ),
    ).toBe("read_only");
  });

  it("lets a read-only lookup replay with no write flag at all", () => {
    const d = gate.check({ kind: "click", ref: "e10" }, ctx({ element: el("button", "Search") }));
    expect(d.verdict).toBe("allow");
    expect(d.risk).toBe("read_only");
  });

  it("blocks an unrecognised button until writes are enabled", () => {
    const unknown: UIElement = { ...el("button", "Search"), name: "Post Adjustment" };
    const d = gate.check({ kind: "click", ref: unknown.ref }, ctx({ element: unknown }));
    expect(d.verdict).toBe("deny");
    if (d.verdict === "deny") expect(d.code).toBe("writes_not_enabled");
  });

  it("requires an approved artifact for unattended writes", () => {
    const btn: UIElement = { ...el("button", "Search"), name: "Continue" };
    const d = gate.check(
      { kind: "click", ref: btn.ref },
      ctx({ element: btn, allowWrites: true, artifactApproved: false }),
    );
    expect(d.verdict).toBe("deny");
    if (d.verdict === "deny") expect(d.code).toBe("artifact_not_approved");
  });

  it("escalates irreversible actions instead of executing them, flag or no flag", () => {
    const commit: UIElement = { ...el("button", "Search"), name: "Commit Sub-Account" };
    const d = gate.check(
      { kind: "click", ref: commit.ref },
      ctx({ element: commit, allowWrites: true, artifactApproved: true }),
    );
    expect(d.verdict).toBe("escalate");
  });

  it("lets a reviewed artifact raise risk but never launder it", () => {
    expect(effectiveRisk("read_only", "irreversible")).toBe("irreversible");
    expect(effectiveRisk("irreversible", "read_only")).toBe("irreversible");
  });
});

describe("redaction", () => {
  it("masks account numbers, SSNs and emails", () => {
    const r = new Redactor();
    const out = r.redactText("acct 4417-99820-01 ssn 123-45-6789 mail a.b@c.io");
    expect(out).not.toContain("4417-99820-01");
    expect(out).not.toContain("123-45-6789");
    expect(out).not.toContain("a.b@c.io");
  });

  it("uses Luhn to avoid masking every long number", () => {
    const r = new Redactor();
    expect(r.redactText("card 4539578763621486")).toContain("[REDACTED:card_pan]");
    expect(r.redactText("ref 1234567890123456")).toContain("1234567890123456");
  });

  it("replaces registered credential values wherever they appear", () => {
    const r = new Redactor();
    r.registerLiteral("hunter2swordfish", "{{secret:password}}");
    expect(r.redactText("typed hunter2swordfish into the box")).toBe(
      "typed {{secret:password}} into the box",
    );
  });

  it("redacts a snapshot and reports what to mask in the screenshot", () => {
    const detail: UISnapshot = JSON.parse(
      readFileSync(
        join(process.cwd(), "tests/fixtures/snapshots/member-detail-variant-a.json"),
        "utf8",
      ),
    );
    const r = new Redactor();
    const { snapshot: clean, sensitiveBounds } = r.redactSnapshot(detail);
    expect(JSON.stringify(clean)).not.toContain("4417-99820-01");
    expect(sensitiveBounds.length).toBeGreaterThan(0);
  });

  it("redacts nested structures headed for a log or artifact", () => {
    const r = new Redactor();
    const out = r.redactJson({ a: [{ b: "acct 4417-99820-01" }] });
    expect(JSON.stringify(out)).not.toContain("4417-99820-01");
  });

  it("tokens declared pii on the replay path, not only during discovery", () => {
    const dir = mkdtempSync(join(tmpdir(), "cua-redact-"));
    try {
      const r = new Redactor();
      const evidence = new EvidenceWriter(dir, "bind", r);
      evidence.bindDeclaredSecrets(
        [
          { name: "ssn", sensitivity: "pii" },
          { name: "memberId", sensitivity: "internal" },
        ],
        { ssn: "not-a-pattern-secret-xyz", memberId: "10042" },
      );
      // The pii value is gone even though no regex would have caught it.
      // The internal member id is left alone - that is a locator, not a secret.
      expect(r.redactText("saw not-a-pattern-secret-xyz for 10042")).toBe(
        "saw {{param:ssn}} for 10042",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* --------------------------------------------------------- no bypass ------ */

class CountingSurface implements Surface {
  acted = 0;
  constructor(private readonly snap: UISnapshot) {}
  capabilities(): SurfaceCapabilities {
    return {
      surfaceType: "web",
      canScreenshot: false,
      supportsFrames: true,
      nativeAccessibilityNames: false,
    };
  }
  async observe(): Promise<UISnapshot> {
    return this.snap;
  }
  async act(_action: SurfaceAction): Promise<ActionResult> {
    this.acted += 1;
    return { ok: true, durationMs: 0 };
  }
}

describe("no action bypasses the gate", () => {
  it("consults the gate exactly once per dispatched action", async () => {
    const gate = new PolicyGate();
    const inner = new CountingSurface(snapshot);
    const surface = new GuardedSurface(inner, {
      gate,
      context: () => ({
        mode: "replay",
        allowlist,
        allowWrites: true,
        artifactApproved: true,
        leaseOwner: "automation",
      }),
    });

    await surface.observe();
    const box = el("textbox", "Member ID");
    const btn = el("button", "Search");
    await surface.act({ kind: "type", ref: box.ref, text: "10042" });
    await surface.act({ kind: "click", ref: btn.ref });
    await surface.act({ kind: "read", ref: btn.ref });

    expect(inner.acted).toBe(3);
    expect(gate.checks).toBe(3);
  });

  it("a denied action never reaches the surface at all", async () => {
    const gate = new PolicyGate();
    const inner = new CountingSurface(snapshot);
    const surface = new GuardedSurface(inner, {
      gate,
      context: () => ({ mode: "replay", allowlist, allowWrites: false, leaseOwner: "automation" }),
    });
    await surface.observe();

    await expect(
      surface.act({ kind: "navigate", url: "https://evil.example/" }),
    ).rejects.toBeInstanceOf(PolicyViolation);
    expect(inner.acted).toBe(0);
    expect(gate.checks).toBe(1);
  });

  it("an irreversible action raises for approval rather than executing", async () => {
    const gate = new PolicyGate();
    const inner = new CountingSurface(snapshot);
    const surface = new GuardedSurface(inner, {
      gate,
      context: () => ({
        mode: "replay",
        allowlist,
        allowWrites: true,
        artifactApproved: true,
        leaseOwner: "automation",
      }),
      declaredRisk: () => "irreversible",
    });
    await surface.observe();
    await expect(
      surface.act({ kind: "click", ref: el("button", "Search").ref }),
    ).rejects.toBeInstanceOf(ApprovalRequired);
    expect(inner.acted).toBe(0);
  });
});
