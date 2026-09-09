/**
 * Code generation from an artifact is a projection, not a second engine.
 *
 * These tests pin the properties that make the stretch goal honest: the snippet
 * speaks role + name + frame path, parameter tokens stay parameters, and
 * structural CSS is not invented from a brittle rung.
 */

import { describe, expect, it } from "vitest";
import { emitPlaywright, locatorFor } from "../src/emit/playwright.js";
import { savingsBalanceCapability } from "./helpers/capability.js";

describe("emit Playwright from an artifact", () => {
  it("projects the recorded ladder as role+name locators, not CSS selectors", () => {
    const source = emitPlaywright(savingsBalanceCapability(), "test");

    expect(source).toContain('getByRole("textbox", { name: "Member ID" })');
    expect(source).toContain('getByRole("button", { name: "Search" })');
    expect(source).toContain('frameLocator("iframe[name=\\"contentFrame\\"]")');
    expect(source).not.toContain("#ctl00");
    expect(source).not.toContain("xpath=");
    expect(source).not.toContain("TBODY[1]");
  });

  it("keeps parameterized names as args, not the member the flow was recorded against", () => {
    const source = emitPlaywright(savingsBalanceCapability(), "test");
    expect(source).toContain("args.memberId");
    expect(source).not.toContain('name: "10042"');
    expect(source).not.toContain("{{param:memberId}}");
  });

  it("addresses a grid cell by row key, not by the value being read", () => {
    const source = emitPlaywright(savingsBalanceCapability(), "page-object");
    expect(source).toContain('getByRole("row", { name: "Savings" })');
    expect(source).toContain("table_cell");
    expect(source).not.toContain("$8,241.17");
  });

  it("page-object format is the class without a test wrapper", () => {
    const source = emitPlaywright(savingsBalanceCapability(), "page-object");
    expect(source).toContain("export class TestMemberSavingsBalancePage");
    expect(source).toContain("args: TestMemberSavingsBalanceArgs");
    expect(source).not.toContain('test("');
  });

  it("nests frame locators in recorded order", () => {
    const cap = savingsBalanceCapability();
    const descriptor = cap.outputs[0]!.extraction.descriptor;
    const { expr } = locatorFor(descriptor);
    expect(expr).toContain('frameLocator("iframe[name=\\"contentFrame\\"]")');
    expect(expr).toContain('frameLocator("iframe[name=\\"acctFrame\\"]")');
    expect(expr.indexOf("contentFrame")).toBeLessThan(expr.indexOf("acctFrame"));
  });
});
