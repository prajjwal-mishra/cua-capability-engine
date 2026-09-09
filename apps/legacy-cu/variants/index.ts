/**
 * Two tenants running the same vendor product, configured and branded
 * differently. Variant B is the stand-in for "the other credit union that
 * bought the same core banking package": same flows, different labels, an
 * extra confirmation step, and slightly different markup.
 *
 * Everything a capability artifact could plausibly bind to that differs
 * between tenants lives here, so the cross-tenant demo exercises real
 * differences rather than cosmetic ones.
 */

export interface Variant {
  readonly id: "variant-a" | "variant-b";
  readonly brand: string;
  readonly brandColor: string;
  /** The label text sitting in the table cell next to the search input. */
  readonly memberIdLabel: string;
  readonly searchButtonLabel: string;
  readonly savingsRowLabel: string;
  readonly balanceColumnHeader: string;
  readonly detailHeading: (name: string) => string;
  /** Variant B interposes an extra "review" screen before the confirmation. */
  readonly subAccountReviewStep: boolean;
  /** ASP.NET-ish control id prefix; differs by vendor build. */
  readonly ctlPrefix: string;
}

export const VARIANTS: Record<string, Variant> = {
  "variant-a": {
    id: "variant-a",
    brand: "Riverbend Credit Union",
    brandColor: "#12304a",
    memberIdLabel: "Member ID",
    searchButtonLabel: "Search",
    savingsRowLabel: "Savings",
    balanceColumnHeader: "Current Balance",
    detailHeading: (name) => `Member Detail - ${name}`,
    subAccountReviewStep: false,
    ctlPrefix: "ctl00_ContentPlaceHolder1",
  },
  "variant-b": {
    id: "variant-b",
    brand: "Summit Federal CU",
    brandColor: "#4a2d12",
    memberIdLabel: "Member Number",
    searchButtonLabel: "Find Member",
    savingsRowLabel: "Share Savings",
    balanceColumnHeader: "Balance",
    detailHeading: (name) => `Account Servicing : ${name}`,
    subAccountReviewStep: true,
    ctlPrefix: "ctl00_MainContent",
  },
};

export function variantFor(id: string | undefined): Variant {
  return VARIANTS[id ?? "variant-a"] ?? VARIANTS["variant-a"]!;
}
