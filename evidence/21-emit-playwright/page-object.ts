/**
 * Generated from member.savings_balance@1.0.0.
 *
 * A projection of the capability artifact - not a second source of truth.
 * Replay still executes the JSON; this file exists so a reviewer can see the
 * recorded ladder as ordinary Playwright, or drop a snippet into an existing
 * suite. Do not edit this and the artifact independently.
 *
 * Target: legacy-cu (corevantage-backoffice)
 * Entry:  /frame/search
 */
import { type Page } from "@playwright/test";

export type MemberSavingsBalanceArgs = {
  memberId: string;
};

export class MemberSavingsBalancePage {
  constructor(private readonly page: Page) {}

  /** s1: Enter the member ID to search for the member (type, risk=read_only) */
  async s1(args: MemberSavingsBalanceArgs): Promise<void> {
    // Enter the member ID to search for the member; ladder label_anchor → role_name → frame_role_ordinal → frame_role_ordinal → structural; using label_anchor (same-row)
    await this.page.frameLocator("iframe[name=\"contentFrame\"]").getByRole("textbox", { name: "Member ID" }).fill(args.memberId);
  }

  /** s2: Click Search to look up member 10042 (click, risk=read_only) */
  async s2(): Promise<void> {
    // Click Search to look up member 10042; ladder role_name → frame_role_ordinal → frame_role_ordinal → structural; using role_name
    await this.page.frameLocator("iframe[name=\"contentFrame\"]").getByRole("button", { name: "Search" }).click();
    // checkpoint: frame route matches "/frame/results"
  }

  /** s3: Open member detail page for member 10042 (click, risk=read_only) */
  async s3(args: MemberSavingsBalanceArgs): Promise<void> {
    // Open member detail page for member 10042; ladder role_name → label_anchor → frame_role_ordinal → frame_role_ordinal → structural; using role_name
    await this.page.frameLocator("iframe[name=\"contentFrame\"]").getByRole("link", { name: args.memberId }).click();
    await this.page.frameLocator("iframe[name=\"contentFrame\"]").getByRole("button", { name: "Open Sub-Account" }).first().waitFor();
  }

  /** Extract output savings_balance. */
  async read_savings_balance(): Promise<string> {
    // the savings balance value; ladder table_cell → frame_role_ordinal → structural; table_cell column "Current Balance" × row "Savings"
    return (await this.page.frameLocator("iframe[name=\"contentFrame\"]").frameLocator("iframe[name=\"acctFrame\"]").getByRole("row", { name: "Savings" }).getByRole("cell").last().textContent())?.trim() ?? "";
  }
}
