/**
 * The target app is a first-class part of the submission, so its behaviour is
 * pinned by tests. If an exceptional state stops firing, the replay evidence
 * that depends on it is quietly worthless — these tests catch that.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../apps/legacy-cu/app.js";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(async () => {
  await fetch(`${base}/__control/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
});

const get = (p: string) => fetch(`${base}${p}`, { redirect: "manual" });
const text = async (p: string) => (await get(p)).text();
const arm = (mode: string, count = 1) =>
  fetch(`${base}/__control/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, count }),
  });

describe("hostile markup properties", () => {
  it("nests the content in frames", async () => {
    const html = await text("/");
    expect(html).toContain('name="navFrame"');
    expect(html).toContain('name="contentFrame"');
  });

  it("puts the accounts grid one frame deeper still", async () => {
    expect(await text("/frame/member/10042")).toContain('name="acctFrame"');
  });

  it("offers no accessible name source for text inputs", async () => {
    // This is the property that forces the legacy heuristic pass: no <label for>,
    // no aria-label, no title. The a11y tree will report an unnamed textbox.
    const html = await text("/frame/search");
    expect(html).not.toMatch(/<label/i);
    expect(html).not.toMatch(/aria-label/i);
    expect(html).toContain('id="ctl00_ContentPlaceHolder1_txt3"');
  });
});

describe("happy path", () => {
  it("searches, lists, and shows a savings balance", async () => {
    expect(await text("/frame/results?q=10042")).toContain("Vantreight");
    expect(await text("/frame/accounts/10042")).toContain("$8,241.17");
  });
});

describe("business outcomes (not failures)", () => {
  it("rejects an empty member id with a validation error", async () => {
    expect(await text("/frame/results?q=")).toContain("is required");
  });

  it("rejects invalid characters", async () => {
    expect(await text("/frame/results?q=%3Cscript%3E")).toContain("invalid characters");
  });

  it("reports record not found", async () => {
    expect(await text("/frame/results?q=99999")).toContain("No member records match");
  });

  it("reports permission denied for a restricted member", async () => {
    const html = await text("/frame/member/10099");
    expect(html).toContain("not authorized");
    expect(html).toContain("SEC-4031");
  });

  it("rejects a sub-account below the deposit minimum", async () => {
    const res = await fetch(`${base}/frame/subaccount/10042`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "variant=variant-a&kind=Savings&nickname=Vacation&initialDeposit=5",
    });
    expect(await res.text()).toContain("at least $25.00");
  });
});

describe("injected runtime conditions", () => {
  it("session timeout renders the login interstitial and recovers", async () => {
    await arm("session_timeout");
    expect(await text("/frame/member/10042")).toContain("session has timed out");
    const res = await fetch(`${base}/frame/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "returnTo=/frame/member/10042&variant=variant-a",
      redirect: "manual",
    });
    expect(res.status).toBe(302);
  });

  it("transient 503 succeeds on retry", async () => {
    await arm("transient_503");
    expect((await get("/frame/member/10042")).status).toBe(503);
    expect((await get("/frame/member/10042")).status).toBe(200);
  });

  it("app error returns a 500 page", async () => {
    await arm("app_error_500");
    const res = await get("/frame/member/10042");
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Server Error in");
  });

  it("interstitial is seeded, not random", async () => {
    // Every 4th member-detail load, reproducibly.
    const hits: number[] = [];
    for (let i = 1; i <= 8; i++) {
      if ((await text("/frame/member/10042")).includes("Acknowledge this notice")) hits.push(i);
    }
    expect(hits).toEqual([4, 8]);
  });
});

describe("variant-b is the same product, configured differently", () => {
  it("renames the member id field", async () => {
    expect(await text("/frame/search?variant=variant-b")).toContain("Member Number");
    expect(await text("/frame/search?variant=variant-a")).toContain("Member ID");
  });

  it("renames the savings row", async () => {
    expect(await text("/frame/accounts/10042?variant=variant-b")).toContain("Share Savings");
  });

  it("interposes an extra review step before the commit", async () => {
    const res = await fetch(`${base}/frame/subaccount/10042`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "variant=variant-b&kind=Savings&nickname=Vacation&initialDeposit=100",
    });
    const html = await res.text();
    expect(html).toContain("Review Request");
    expect(html).toContain("Commit Sub-Account");
  });

  it("variant-a commits without the review step", async () => {
    const res = await fetch(`${base}/frame/subaccount/10042`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "variant=variant-a&kind=Savings&nickname=Vacation&initialDeposit=100",
    });
    expect(await res.text()).toContain("Sub-account opened successfully");
  });
});
