/**
 * Deterministic injection of the exceptional states the brief names.
 *
 * Design note: injections are armed OUT OF BAND, via POST /__control/inject,
 * rather than through a query flag on the page URL. That matters. If the test
 * hook lived in the URL, a replay demonstrating "session timeout" would be
 * navigating to a *different route* than the one the capability recorded, and
 * the demo would be proving nothing. Arming out of band means the automation
 * drives byte-identical URLs whether or not a fault is pending.
 */

export type InjectionMode =
  "session_timeout" | "transient_503" | "app_error_500" | "interstitial" | "slow_load";

interface ArmedInjection {
  mode: InjectionMode;
  /** How many further matching requests this injection applies to. */
  remaining: number;
  /** Only fire on request paths containing this substring, if set. */
  pathContains?: string;
}

const armed: ArmedInjection[] = [];

/** Monotonic per-path counter, so "appears on a fraction of loads" is seeded
 *  and reproducible rather than genuinely random. */
const loadCounts = new Map<string, number>();

export function arm(mode: InjectionMode, count = 1, pathContains?: string): void {
  armed.push({ mode, remaining: count, pathContains });
}

export function clearInjections(): void {
  armed.length = 0;
  loadCounts.clear();
}

export function listInjections(): readonly ArmedInjection[] {
  return armed.map((a) => ({ ...a }));
}

/** Consume and return the injection that applies to this path, if any. */
export function takeInjection(path: string): InjectionMode | undefined {
  const idx = armed.findIndex(
    (a) => a.remaining > 0 && (a.pathContains === undefined || path.includes(a.pathContains)),
  );
  if (idx === -1) return undefined;
  const entry = armed[idx]!;
  entry.remaining -= 1;
  if (entry.remaining <= 0) armed.splice(idx, 1);
  return entry.mode;
}

/**
 * The seeded "unexpected confirmation dialog". Fires on every Nth load of a
 * given path. Reproducible: same request sequence, same interstitials.
 */
export function seededInterstitial(path: string, everyNth: number): boolean {
  const n = (loadCounts.get(path) ?? 0) + 1;
  loadCounts.set(path, n);
  return everyNth > 0 && n % everyNth === 0;
}

export function resetLoadCounts(): void {
  loadCounts.clear();
}
