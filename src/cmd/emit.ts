/**
 * `cua emit` — project an artifact into a Playwright page object / test.
 *
 * Stretch goal from the brief. The generated file is a projection so a reviewer
 * can read the recorded ladder as ordinary Playwright. It is not how production
 * replay runs; that still executes the JSON with no model in the loop.
 */

import { writeFileSync } from "node:fs";
import type { Args } from "../cli-args.js";
import { ArtifactStore } from "../artifact/store.js";
import { emitPlaywright, type EmitFormat } from "../emit/playwright.js";

export async function emitCommand(args: Args): Promise<void> {
  const ref = String(args.flags.capability ?? args.positional[0] ?? "");
  if (!ref) throw new Error("emit requires --capability <id>[@<version>]");

  const format = (args.flags.format ? String(args.flags.format) : "test") as EmitFormat;
  if (format !== "test" && format !== "page-object") {
    throw new Error("emit --format must be 'test' or 'page-object'");
  }

  const tenant = args.flags.tenant ? String(args.flags.tenant) : undefined;
  const store = new ArtifactStore();
  const { artifact, overlay } = store.resolve(ref, tenant);
  const source = emitPlaywright(artifact, format);

  const out = args.flags.out ? String(args.flags.out) : undefined;
  if (out) {
    writeFileSync(out, source);
    console.log(`wrote ${out}  (${artifact.capabilityId}@${artifact.version}${overlay ? `, overlay ${overlay.overlayId}` : ""})`);
    return;
  }
  process.stdout.write(source);
}
