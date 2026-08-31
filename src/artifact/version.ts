/**
 * Minimal semver. Deliberately not a dependency: we need parse, compare, and
 * three range forms, and a 200-line file we can read beats a transitive tree.
 */

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parseVersion(v: string): SemVer {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) throw new Error(`not a semver: ${v}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

/**
 * Ranges an overlay may pin itself to:
 *   "*"        any base
 *   "1.2.3"    exactly this base
 *   "^1.2.3"   same major, at least this version
 *   "~1.2.3"   same major+minor, at least this patch
 */
export function satisfies(version: string, range: string): boolean {
  const r = range.trim();
  if (r === "*") return true;
  if (r.startsWith("^")) {
    const base = parseVersion(r.slice(1));
    const v = parseVersion(version);
    return v.major === base.major && compareVersions(version, r.slice(1)) >= 0;
  }
  if (r.startsWith("~")) {
    const base = parseVersion(r.slice(1));
    const v = parseVersion(version);
    return (
      v.major === base.major && v.minor === base.minor && compareVersions(version, r.slice(1)) >= 0
    );
  }
  return compareVersions(version, r) === 0;
}

export function latest(versions: readonly string[]): string | undefined {
  return [...versions].sort(compareVersions).pop();
}

/** `member.savings_balance@1.0.0` → parts. Version is optional. */
export function parseCapabilityRef(ref: string): { capabilityId: string; version?: string } {
  const at = ref.lastIndexOf("@");
  if (at <= 0) return { capabilityId: ref };
  return { capabilityId: ref.slice(0, at), version: ref.slice(at + 1) };
}
