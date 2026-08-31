/**
 * Seeded fake members. Obviously synthetic: names from a fictional-place list,
 * member numbers in a reserved 1xxxx block, no real PII anywhere. The account
 * numbers are deliberately shaped like real ones (so the redactor has something
 * to bite on) but are not issuable values.
 */

export type AccountKind = "Savings" | "Checking" | "Certificate" | "Loan";

export interface Account {
  readonly accountNumber: string;
  readonly kind: AccountKind;
  readonly balance: number;
  readonly openedOn: string;
  readonly status: "Open" | "Dormant" | "Closed";
}

export interface Member {
  readonly memberId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly branch: string;
  readonly joinedOn: string;
  /** Drives the permission-denied exceptional state. */
  readonly restricted: boolean;
  readonly accounts: readonly Account[];
}

export const MEMBERS: readonly Member[] = [
  {
    memberId: "10042",
    firstName: "Marisol",
    lastName: "Vantreight",
    branch: "Riverbend Main",
    joinedOn: "2016-03-14",
    restricted: false,
    accounts: [
      {
        accountNumber: "4417-99820-01",
        kind: "Savings",
        balance: 8241.17,
        openedOn: "2016-03-14",
        status: "Open",
      },
      {
        accountNumber: "4417-99820-02",
        kind: "Checking",
        balance: 1902.44,
        openedOn: "2016-03-14",
        status: "Open",
      },
      {
        accountNumber: "4417-99820-07",
        kind: "Certificate",
        balance: 15000.0,
        openedOn: "2021-11-02",
        status: "Open",
      },
    ],
  },
  {
    memberId: "10077",
    firstName: "Devraj",
    lastName: "Okonkwo-Hale",
    branch: "Northgate",
    joinedOn: "2019-08-01",
    restricted: false,
    accounts: [
      {
        accountNumber: "4417-31145-01",
        kind: "Savings",
        balance: 312.09,
        openedOn: "2019-08-01",
        status: "Open",
      },
      {
        accountNumber: "4417-31145-03",
        kind: "Loan",
        balance: -18400.55,
        openedOn: "2022-05-19",
        status: "Open",
      },
    ],
  },
  {
    memberId: "10099",
    firstName: "Perpetua",
    lastName: "Stillwater",
    branch: "Executive Services",
    joinedOn: "2011-01-09",
    restricted: true, // → permission_denied on detail view
    accounts: [
      {
        accountNumber: "4417-70003-01",
        kind: "Savings",
        balance: 250400.0,
        openedOn: "2011-01-09",
        status: "Open",
      },
    ],
  },
  {
    memberId: "10123",
    firstName: "Ottoline",
    lastName: "Bramblecourt",
    branch: "Riverbend Main",
    joinedOn: "2023-02-27",
    restricted: false,
    accounts: [
      {
        accountNumber: "4417-88120-01",
        kind: "Savings",
        balance: 0.0,
        openedOn: "2023-02-27",
        status: "Dormant",
      },
    ],
  },
];

export function findMember(memberId: string): Member | undefined {
  return MEMBERS.find((m) => m.memberId === memberId.trim());
}

/** Substring search over id and last name, mirroring the legacy app's behaviour. */
export function searchMembers(query: string): readonly Member[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  return MEMBERS.filter(
    (m) =>
      m.memberId.includes(q) ||
      m.lastName.toLowerCase().includes(q) ||
      m.firstName.toLowerCase().includes(q),
  );
}

export function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
