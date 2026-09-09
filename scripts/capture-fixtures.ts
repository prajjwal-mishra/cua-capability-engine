/**
 * Capture real UISnapshots from the legacy app and save them as test fixtures.
 *
 * The resolver is a pure function of (descriptor, snapshot), so freezing real
 * snapshots lets the whole locator ladder be tested in milliseconds with no
 * browser - while still being tested against markup the app actually produced,
 * not markup someone hand-wrote to make the tests pass.
 */

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../apps/legacy-cu/app.js";
import { WebSurface } from "../src/surface/web.surface.js";
import type { UISnapshot } from "../src/surface/types.js";

const OUT = join(process.cwd(), "tests/fixtures/snapshots");
/** Fixtures are committed test data, so they must not carry the ephemeral port
 *  this script happened to bind. Rewrite to the canonical demo origin. */
const CANONICAL = "http://localhost:4000";
const canonicalize = (snap: UISnapshot, from: string): UISnapshot =>
  JSON.parse(JSON.stringify(snap).split(from).join(CANONICAL));

const app = createApp();
const server = app.listen(0);
const addr = server.address();
if (typeof addr === "string" || addr === null) throw new Error("no port");
const base = `http://127.0.0.1:${addr.port}`;

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const surface = new WebSurface(page);

async function capture(name: string, url: string): Promise<UISnapshot> {
  await page.goto(url);
  const snap = canonicalize(await surface.observe(), base);
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(snap, null, 2));
  console.log(`${name.padEnd(28)} ${snap.elements.length} elements`);
  return snap;
}

await capture("search-variant-a", `${base}/`);
await capture("search-variant-b", `${base}/?variant=variant-b`);
await capture("results", `${base}/frame/results?q=10042`);
await capture("member-detail-variant-a", `${base}/frame/member/10042`);
await capture("member-detail-variant-b", `${base}/frame/member/10042?variant=variant-b`);
await capture("not-found", `${base}/frame/results?q=99999`);
await capture("permission-denied", `${base}/frame/member/10099`);
await capture("subaccount-form", `${base}/frame/subaccount/10042`);

// The shell-framed member view, which is where framePath depth actually matters.
await page.goto(`${base}/`);
await page.evaluate(() => {
  (document.getElementById("contentFrame") as HTMLIFrameElement).src = "/frame/member/10042";
});
await page.waitForTimeout(300);
const framed = canonicalize(await surface.observe(), base);
writeFileSync(join(OUT, "member-detail-framed.json"), JSON.stringify(framed, null, 2));
console.log(`${"member-detail-framed".padEnd(28)} ${framed.elements.length} elements`);

await browser.close();
server.close();
