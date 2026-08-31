/**
 * The allowlist. Deny by default: anything not explicitly permitted is refused,
 * and the refusal names which rule refused it.
 *
 * Scoped per tenant + app, because "what this automation may touch" is a
 * property of the institution and its vendor product, not of the code.
 */

import { z } from "zod";
import { readFileSync } from "node:fs";

export const AllowlistSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  appId: z.string(),
  /** Exact origins. No wildcards: an origin wildcard is how automation ends up
   *  on a domain nobody approved. */
  origins: z.array(z.string().url()).min(1),
  /** Glob-ish route patterns; `*` matches one segment, `**` matches the rest. */
  routePatterns: z.array(z.string()).min(1),
  /** Checked before routePatterns, so a deny always wins. */
  deniedRoutePatterns: z.array(z.string()).default([]),
  actions: z
    .array(z.enum(["navigate", "click", "type", "select", "key", "read", "waitFor", "scroll"]))
    .min(1),
  targetRoles: z.array(z.string()).min(1),
  /** Fields the automation must never type into, matched against the control's
   *  accessible name. */
  forbiddenFieldPatterns: z.array(z.string()).default([]),
  risk: z.object({
    irreversible: z.array(z.string()).default([]),
    write: z.array(z.string()).default([]),
    readOnly: z.array(z.string()).default([]),
  }),
  /** Coordinate clicking stays off unless an operator deliberately enables it. */
  allowCoordinateFallback: z.boolean().default(false),
});

export type Allowlist = z.infer<typeof AllowlistSchema>;

export function loadAllowlist(path: string): Allowlist {
  return AllowlistSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** `/frame/*` matches one segment; `/frame/**` matches everything below. */
export function routeMatches(pattern: string, path: string): boolean {
  const rx = new RegExp(
    "^" +
      pattern
        .split("/")
        .map((seg) => {
          if (seg === "**") return "__DOUBLE__";
          if (seg === "*") return "[^/]*";
          return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/")
        .replace("/__DOUBLE__", "(/.*)?") +
      "$",
  );
  return rx.test(path);
}

export interface OriginCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

export function checkUrl(allowlist: Allowlist, rawUrl: string): OriginCheck {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `not a valid URL: ${rawUrl}` };
  }
  if (!allowlist.origins.includes(u.origin)) {
    return { ok: false, reason: `origin ${u.origin} is not on the allowlist` };
  }
  for (const denied of allowlist.deniedRoutePatterns) {
    if (routeMatches(denied, u.pathname)) {
      return { ok: false, reason: `route ${u.pathname} matches denied pattern ${denied}` };
    }
  }
  if (!allowlist.routePatterns.some((p) => routeMatches(p, u.pathname))) {
    return { ok: false, reason: `route ${u.pathname} matches no permitted pattern` };
  }
  return { ok: true };
}
