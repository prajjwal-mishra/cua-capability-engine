/**
 * Evidence collection. Everything a run produces lands under one directory so a
 * reviewer can read a single folder and understand what happened.
 *
 * Screenshots pass through the surface's masking path, never through a raw
 * capture — see WebSurface.screenshot.
 */

import { mkdirSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Redactor } from "../policy/redact.js";
import type { Surface, UISnapshot } from "../surface/types.js";

export class EvidenceWriter {
  readonly dir: string;

  constructor(
    root: string,
    readonly runId: string,
    private readonly redactor: Redactor,
  ) {
    this.dir = join(root, runId);
    mkdirSync(join(this.dir, "snapshots"), { recursive: true });
    mkdirSync(join(this.dir, "screenshots"), { recursive: true });
  }

  get logPath(): string {
    return join(this.dir, "run.jsonl");
  }

  /** Redact, write, and return the redacted snapshot for downstream use. */
  saveSnapshot(label: string, snapshot: UISnapshot): UISnapshot {
    const { snapshot: clean } = this.redactor.redactSnapshot(snapshot);
    writeFileSync(join(this.dir, "snapshots", `${label}.json`), JSON.stringify(clean, null, 2));
    return clean;
  }

  /**
   * Capture a screenshot with every sensitive region masked before encoding.
   * Returns the relative path, or undefined if the surface cannot screenshot.
   */
  async saveScreenshot(
    label: string,
    surface: Surface,
    snapshot: UISnapshot,
  ): Promise<string | undefined> {
    if (!surface.screenshot) return undefined;
    const { sensitiveBounds } = this.redactor.redactSnapshot(snapshot);
    const png = await surface.screenshot(sensitiveBounds);
    const rel = join("screenshots", `${label}.png`);
    writeFileSync(join(this.dir, rel), png);
    return rel;
  }

  saveJson(name: string, value: unknown): string {
    const path = join(this.dir, name);
    mkdirSync(join(this.dir, name, "..").replace(/\/\.\.$/, ""), { recursive: true });
    writeFileSync(path, JSON.stringify(this.redactor.redactJson(value), null, 2) + "\n");
    return path;
  }

  saveText(name: string, text: string): string {
    const path = join(this.dir, name);
    writeFileSync(path, this.redactor.redactText(text));
    return path;
  }

  /** Publish a finished run into the committed /evidence tree. */
  publishTo(target: string): void {
    if (!existsSync(this.dir)) return;
    mkdirSync(target, { recursive: true });
    cpSync(this.dir, target, { recursive: true });
  }
}
