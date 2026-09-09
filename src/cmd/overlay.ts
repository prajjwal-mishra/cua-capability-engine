/**
 * `cua overlay` - tenant specialization, including proposals from a human
 * handoff. Applying an overlay is a review. Generating one from captured
 * clicks is what stops the same escalation from costing a human forever.
 */

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Args } from "../cli-args.js";
import { ArtifactStore } from "../artifact/store.js";
import { OverlaySchema } from "../artifact/overlays.js";
import { InterventionSchema } from "../escalation/intervention.js";
import { proposeOverlayFromIntervention } from "../artifact/propose.js";

export async function overlayCommand(args: Args): Promise<void> {
  const sub = args.positional[0];
  if (sub !== "propose") {
    throw new Error("overlay expected subcommand 'propose'");
  }

  const from = String(args.flags.from ?? "");
  const tenant = String(args.flags.tenant ?? "");
  if (!from) throw new Error("overlay propose requires --from <intervention.json>");
  if (!tenant) throw new Error("overlay propose requires --tenant <id>");

  const intervention = InterventionSchema.parse(JSON.parse(readFileSync(from, "utf8")));
  const store = new ArtifactStore();
  const base = store.load(intervention.capability);
  const variant = args.flags.variant ? String(args.flags.variant) : undefined;
  const { overlay, notes } = proposeOverlayFromIntervention(base, intervention, {
    tenant,
    variant,
  });
  const parsed = OverlaySchema.parse(overlay);

  for (const note of notes) console.log(`  ${note}`);

  const inserted = parsed.patch.insertSteps.length;
  const source = JSON.stringify(parsed, null, 2) + "\n";
  const out = args.flags.out ? String(args.flags.out) : undefined;
  if (out) {
    const dir = dirname(out);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    writeFileSync(out, source);
    console.log(
      `\nwrote ${out}  (${inserted} inserted step(s) - proposal, not applied)`,
    );
    return;
  }
  process.stdout.write(source);
}
