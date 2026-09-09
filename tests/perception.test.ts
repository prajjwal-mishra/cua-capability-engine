/**
 * Perception against a real browser and the real target app.
 *
 * The locator tests run on frozen snapshots; these prove the snapshots are
 * faithful in the first place - in particular that the accessibility pass
 * genuinely fails on this markup and the heuristic pass genuinely rescues it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { Server } from "node:http";
import { createApp } from "../apps/legacy-cu/app.js";
import { WebSurface } from "../src/surface/web.surface.js";

let server: Server;
let browser: Browser;
let page: Page;
let surface: WebSurface;
let base: string;

beforeAll(async () => {
  await new Promise<void>((r) => {
    server = createApp().listen(0, r);
  });
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
  browser = await chromium.launch({ headless: true });
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  surface = new WebSurface(page);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("accessibility-first perception with a legacy fallback", () => {
  it("names a button from its value attribute", async () => {
    await page.goto(`${base}/frame/search`);
    const snap = await surface.observe();
    const btn = snap.elements.find((e) => e.role === "button");
    expect(btn?.name).toBe("Search");
    expect(btn?.nameSource).toBe("value");
  });

  it("recovers an unnamed textbox from the adjacent table cell", async () => {
    await page.goto(`${base}/frame/search`);
    const snap = await surface.observe();
    const box = snap.elements.find((e) => e.role === "textbox");
    // The markup offers no label, aria, title or placeholder - the a11y pass
    // returns nothing and the layout is the only remaining source of meaning.
    expect(box?.name).toBe("Member ID");
    expect(box?.nameSource).toBe("heuristic-table-cell");
    expect(box?.nearbyText.leftCell).toBe("Member ID");
  });

  it("walks nested frames and records the path", async () => {
    await page.goto(`${base}/`);
    await page.evaluate(() => {
      (document.getElementById("contentFrame") as HTMLIFrameElement).src = "/frame/member/10042";
    });
    await page.waitForTimeout(300);
    const snap = await surface.observe();
    const paths = new Set(snap.elements.map((e) => e.framePath.join(">")));
    expect(paths.has("navFrame")).toBe(true);
    expect(paths.has("contentFrame")).toBe(true);
    expect(paths.has("contentFrame>acctFrame")).toBe(true);
  });

  it("gives every grid cell a column header and row key", async () => {
    await page.goto(`${base}/frame/accounts/10042`);
    const snap = await surface.observe();
    const balance = snap.elements.find(
      (e) => e.nearbyText.columnHeader === "Current Balance" && e.nearbyText.rowKey === "Savings",
    );
    expect(balance?.name).toBe("$8,241.17");
  });

  it("reports each frame's own route, since the shell URL never changes", async () => {
    await page.goto(`${base}/`);
    await page.evaluate(() => {
      (document.getElementById("contentFrame") as HTMLIFrameElement).src = "/frame/member/10042";
    });
    await page.waitForTimeout(300);
    const snap = await surface.observe();
    expect(snap.page.routePattern).toBe("/");
    const content = snap.page.frames.find((f) => f.framePath.join(">") === "contentFrame");
    expect(content?.routePattern).toBe("/frame/member/:id");
  });
});

describe("acting through the port", () => {
  it("types, clicks, and reads without a CSS selector anywhere", async () => {
    await page.goto(`${base}/frame/search`);
    let snap = await surface.observe();
    const box = snap.elements.find((e) => e.role === "textbox" && e.name === "Member ID")!;
    expect((await surface.act({ kind: "type", ref: box.ref, text: "10042" })).ok).toBe(true);

    snap = await surface.observe();
    const btn = snap.elements.find((e) => e.role === "button" && e.name === "Search")!;
    expect((await surface.act({ kind: "click", ref: btn.ref })).ok).toBe(true);

    snap = await surface.observe();
    const link = snap.elements.find((e) => e.role === "link" && e.name === "10042")!;
    expect((await surface.act({ kind: "click", ref: link.ref })).ok).toBe(true);

    snap = await surface.observe();
    const balance = snap.elements.find(
      (e) => e.nearbyText.columnHeader === "Current Balance" && e.nearbyText.rowKey === "Savings",
    )!;
    const read = await surface.act({ kind: "read", ref: balance.ref });
    expect(read.text).toBe("$8,241.17");
  }, 30_000);

  it("fails loudly on a stale ref rather than acting on the wrong element", async () => {
    await page.goto(`${base}/frame/search`);
    const res = await surface.act({ kind: "click", ref: "e9999" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/snapshot-scoped/);
  });
});
