/**
 * Artifact storage. A directory of JSON files, on purpose.
 *
 * The brief explicitly does not reward building scaling infrastructure, and a
 * capability catalogue is a small, slow-changing, human-reviewed corpus — git
 * is a better fit for it than a database, because the review workflow we
 * actually want (diff, approve, roll back) is the one git already has.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "./schema.js";
import { applyOverlay, OverlaySchema, type Overlay } from "./overlays.js";
import { compareVersions, latest, parseCapabilityRef } from "./version.js";

export interface StorePaths {
  readonly capabilities: string;
  readonly overlays: string;
}

export const DEFAULT_PATHS: StorePaths = {
  capabilities: join(process.cwd(), "capabilities"),
  overlays: join(process.cwd(), "overlays"),
};

const fileName = (id: string, version: string): string => `${id}@${version}.json`;

export class ArtifactStore {
  constructor(private readonly paths: StorePaths = DEFAULT_PATHS) {}

  save(artifact: CapabilityArtifact): string {
    const parsed = CapabilityArtifactSchema.parse(artifact);
    mkdirSync(this.paths.capabilities, { recursive: true });
    const path = join(this.paths.capabilities, fileName(parsed.capabilityId, parsed.version));
    writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");
    return path;
  }

  /** Every stored version of every capability, newest version first. */
  list(): CapabilityArtifact[] {
    if (!existsSync(this.paths.capabilities)) return [];
    return readdirSync(this.paths.capabilities)
      .filter((f) => f.endsWith(".json"))
      .map((f) =>
        CapabilityArtifactSchema.parse(
          JSON.parse(readFileSync(join(this.paths.capabilities, f), "utf8")),
        ),
      )
      .sort(
        (a, b) =>
          a.capabilityId.localeCompare(b.capabilityId) || compareVersions(b.version, a.version),
      );
  }

  versionsOf(capabilityId: string): string[] {
    return this.list()
      .filter((a) => a.capabilityId === capabilityId)
      .map((a) => a.version);
  }

  /** `member.savings_balance` or `member.savings_balance@1.0.0`. */
  load(ref: string): CapabilityArtifact {
    const { capabilityId, version } = parseCapabilityRef(ref);
    const resolved = version ?? latest(this.versionsOf(capabilityId));
    if (!resolved) throw new Error(`no capability found for '${capabilityId}'`);
    const path = join(this.paths.capabilities, fileName(capabilityId, resolved));
    if (!existsSync(path)) {
      throw new Error(
        `capability ${capabilityId}@${resolved} not found; available: ${this.versionsOf(capabilityId).join(", ") || "none"}`,
      );
    }
    return CapabilityArtifactSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  /* ------------------------------------------------------------ overlays -- */

  /**
   * `overlays/<vendorProduct>/<tenant>/<capabilityId>.json`.
   *
   * Keyed by capability as well as tenant, because a tenant runs ~20 apps with
   * many capabilities each. Keying only on (product, tenant) would force one
   * institution's every specialization into a single document — the exact
   * "unreviewable patch swamp" that separate overlay files exist to avoid.
   */
  overlayPath(vendorProduct: string, tenant: string, capabilityId: string): string {
    return join(this.paths.overlays, vendorProduct, tenant, `${capabilityId}.json`);
  }

  saveOverlay(vendorProduct: string, overlay: Overlay): string {
    const parsed = OverlaySchema.parse(overlay);
    const path = this.overlayPath(vendorProduct, parsed.tenant, parsed.basedOn.capabilityId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");
    return path;
  }

  loadOverlay(vendorProduct: string, tenant: string, capabilityId: string): Overlay | undefined {
    const path = this.overlayPath(vendorProduct, tenant, capabilityId);
    if (!existsSync(path)) return undefined;
    return OverlaySchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  /**
   * Capability resolution order: tenant overlay applied over vendor-product
   * base. One recording serves many tenants; a tenant that has not drifted has
   * no overlay file at all, which is the common case and costs nothing.
   */
  resolve(ref: string, tenant?: string): { artifact: CapabilityArtifact; overlay?: Overlay } {
    const base = this.load(ref);
    if (!tenant) return { artifact: base };
    const overlay = this.loadOverlay(base.target.vendorProduct, tenant, base.capabilityId);
    if (!overlay) return { artifact: base };
    return { artifact: applyOverlay(base, overlay), overlay };
  }

  /** Record a replay outcome against the capability's stability signal. */
  recordRun(ref: string, success: boolean): void {
    const artifact = this.load(ref);
    const stability = artifact.lifecycle.stability;
    this.save({
      ...artifact,
      lifecycle: {
        ...artifact.lifecycle,
        stability: {
          runs: stability.runs + 1,
          successes: stability.successes + (success ? 1 : 0),
          lastVerifiedAt: new Date().toISOString(),
        },
      },
    });
  }
}
