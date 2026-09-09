/**
 * Server-rendered markup for the legacy credit-union back office.
 *
 * This is deliberately hostile, in the specific ways enterprise apps of a
 * certain vintage are hostile:
 *
 *   - layout by deeply nested tables, <font> tags, spacer cells
 *   - no data-testid, no aria-*, no <label for>: a field's label is simply
 *     the table cell to its left
 *   - auto-generated ASP.NET control ids (ctl00_ContentPlaceHolder1_txt3)
 *     that carry no meaning and change with the vendor build
 *   - actions as <a href="javascript:void(0)" onclick> and
 *     <input type="button">, never a semantic <button>
 *   - nested iframes, so every element lives at a frame path
 *
 * The point is that the accessibility tree alone will NOT name the text
 * inputs here (no label association exists to compute an accessible name
 * from). That is what forces the legacy heuristic pass, and it is the
 * honest version of the problem the brief describes.
 */

import type { Member } from "../data/seed.js";
import { money } from "../data/seed.js";
import type { Variant } from "../variants/index.js";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const FONT = `face="Verdana, Arial" size="2"`;

function page(v: Variant, title: string, body: string): string {
  return `<html>
<head><title>${esc(title)}</title>
<style>
  body { margin:0; background:#e8e8e0; font-family: Verdana, Arial, sans-serif; font-size: 12px; }
  table { border-collapse: collapse; }
  .hdr { background:${v.brandColor}; color:#fff; padding:6px 10px; font-weight:bold; }
  .panel { background:#fff; border:1px solid #999; }
  .lbl { background:#dcdcd2; padding:4px 8px; white-space:nowrap; }
  .fld { padding:4px 8px; }
  .grid th { background:#c8c8bc; border:1px solid #999; padding:3px 6px; text-align:left; }
  .grid td { border:1px solid #bbb; padding:3px 6px; }
  .err { color:#a00; font-weight:bold; }
  input[type=text] { border:1px solid #7a7a7a; font-family:Verdana; font-size:12px; padding:2px; }
  input[type=button], input[type=submit] { font-family:Verdana; font-size:12px; }
</style></head>
<body>${body}</body></html>`;
}

/* ------------------------------------------------------------------ shell */

/** Top-level frame shell: nav frame + content frame. */
export function shell(v: Variant, contentUrl: string): string {
  return `<html><head><title>${esc(v.brand)} - Back Office</title>
<style>html,body{margin:0;height:100%;background:#e8e8e0;} iframe{border:0;}</style></head>
<body>
<table width="100%" height="100%" cellpadding="0" cellspacing="0"><tr>
  <td width="180" valign="top">
    <iframe name="navFrame" id="navFrame" src="/frame/nav" width="180" height="600"></iframe>
  </td>
  <td valign="top">
    <iframe name="contentFrame" id="contentFrame" src="${esc(contentUrl)}" width="100%" height="600"></iframe>
  </td>
</tr></table>
</body></html>`;
}

export function navFrame(v: Variant): string {
  const link = (label: string, href: string) =>
    `<tr><td class="fld"><font ${FONT}><a href="javascript:void(0)" onclick="parent.contentFrame.location='${href}';return false;">${esc(label)}</a></font></td></tr>`;
  return page(
    v,
    "Navigation",
    `<table width="100%" cellpadding="0" cellspacing="0">
      <tr><td class="hdr"><font ${FONT} color="#ffffff">${esc(v.brand)}</font></td></tr>
      ${link("Member Search", `/frame/search?variant=${v.id}`)}
      ${link("Reports", `/frame/unavailable?variant=${v.id}`)}
      ${link("Batch Jobs", `/frame/unavailable?variant=${v.id}`)}
    </table>`,
  );
}

/* ----------------------------------------------------------------- search */

export function searchPage(v: Variant, error?: string): string {
  const p = v.ctlPrefix;
  return page(
    v,
    `${v.brand} - Member Search`,
    `<table width="100%" cellpadding="0" cellspacing="0"><tr><td class="hdr"><font ${FONT} color="#ffffff">Member Search</font></td></tr></table>
<form method="get" action="/frame/results">
<input type="hidden" name="variant" value="${esc(v.id)}">
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td>
  <table class="panel" cellpadding="0" cellspacing="0" border="0" width="480"><tr><td>
    <table cellpadding="2" cellspacing="0" border="0">
      <tr><td colspan="2" height="6"></td></tr>
      <tr>
        <td class="lbl"><font ${FONT}>${esc(v.memberIdLabel)}</font></td>
        <td class="fld"><input type="text" name="q" id="${p}_txt3" size="24" maxlength="12"></td>
      </tr>
      <tr>
        <td class="lbl"><font ${FONT}>Branch</font></td>
        <td class="fld"><input type="text" name="branch" id="${p}_txt7" size="24"></td>
      </tr>
      <tr>
        <td></td>
        <td class="fld"><input type="submit" id="${p}_btnGo" value="${esc(v.searchButtonLabel)}"></td>
      </tr>
      ${error ? `<tr><td colspan="2" class="fld"><font ${FONT} class="err">${esc(error)}</font></td></tr>` : ""}
      <tr><td colspan="2" height="6"></td></tr>
    </table>
  </td></tr></table>
</td></tr></table>
</form>`,
  );
}

export function resultsPage(v: Variant, members: readonly Member[], query: string): string {
  const rows = members
    .map(
      (m) => `<tr>
      <td><font ${FONT}><a href="javascript:void(0)" onclick="location='/frame/member/${esc(m.memberId)}?variant=${v.id}';return false;">${esc(m.memberId)}</a></font></td>
      <td><font ${FONT}>${esc(m.lastName)}, ${esc(m.firstName)}</font></td>
      <td><font ${FONT}>${esc(m.branch)}</font></td>
    </tr>`,
    )
    .join("\n");
  return page(
    v,
    `${v.brand} - Search Results`,
    `<table width="100%" cellpadding="0" cellspacing="0"><tr><td class="hdr"><font ${FONT} color="#ffffff">Search Results</font></td></tr></table>
<table cellpadding="4"><tr><td><font ${FONT}>Results for &quot;${esc(query)}&quot;</font></td></tr></table>
<table cellpadding="0" cellspacing="0"><tr><td>
  <table class="grid" cellpadding="0" cellspacing="0" border="0">
    <tr><th><font ${FONT}>${esc(v.memberIdLabel)}</font></th><th><font ${FONT}>Name</font></th><th><font ${FONT}>Branch</font></th></tr>
    ${rows}
  </table>
</td></tr></table>
<table cellpadding="4"><tr><td><font ${FONT}><a href="/frame/search?variant=${v.id}">New Search</a></font></td></tr></table>`,
  );
}

export function noResultsPage(v: Variant, query: string): string {
  return page(
    v,
    `${v.brand} - Search Results`,
    `<table width="100%" cellpadding="0" cellspacing="0"><tr><td class="hdr"><font ${FONT} color="#ffffff">Search Results</font></td></tr></table>
<table cellpadding="8"><tr><td>
  <font ${FONT} class="err">No member records match the criteria supplied.</font><br><br>
  <font ${FONT}>Searched for: ${esc(query)}</font><br><br>
  <font ${FONT}><a href="/frame/search?variant=${v.id}">New Search</a></font>
</td></tr></table>`,
  );
}

/* ----------------------------------------------------------------- detail */

/** Member detail. The accounts grid lives in a NESTED iframe, so account
 *  elements sit two frames deep: contentFrame → acctFrame. */
export function memberDetail(v: Variant, m: Member): string {
  return page(
    v,
    v.detailHeading(`${m.firstName} ${m.lastName}`),
    `<table width="100%" cellpadding="0" cellspacing="0"><tr><td class="hdr"><font ${FONT} color="#ffffff">${esc(v.detailHeading(`${m.firstName} ${m.lastName}`))}</font></td></tr></table>
<table cellpadding="0" cellspacing="0" border="0"><tr><td>
  <table class="panel" cellpadding="0" cellspacing="0"><tr><td>
    <table cellpadding="2" cellspacing="0" border="0">
      <tr><td class="lbl"><font ${FONT}>${esc(v.memberIdLabel)}</font></td><td class="fld"><font ${FONT}>${esc(m.memberId)}</font></td></tr>
      <tr><td class="lbl"><font ${FONT}>Name</font></td><td class="fld"><font ${FONT}>${esc(m.lastName)}, ${esc(m.firstName)}</font></td></tr>
      <tr><td class="lbl"><font ${FONT}>Branch</font></td><td class="fld"><font ${FONT}>${esc(m.branch)}</font></td></tr>
      <tr><td class="lbl"><font ${FONT}>Member Since</font></td><td class="fld"><font ${FONT}>${esc(m.joinedOn)}</font></td></tr>
    </table>
  </td></tr></table>
</td></tr></table>
<table cellpadding="4"><tr><td><font ${FONT}><b>Accounts</b></font></td></tr></table>
<iframe name="acctFrame" id="acctFrame" src="/frame/accounts/${esc(m.memberId)}?variant=${v.id}" width="640" height="180" frameborder="0"></iframe>
<table cellpadding="4"><tr>
  <td><input type="button" id="${v.ctlPrefix}_btnNewSub" value="Open Sub-Account" onclick="location='/frame/subaccount/${esc(m.memberId)}?variant=${v.id}'"></td>
  <td><font ${FONT}><a href="/frame/search?variant=${v.id}">Back to Search</a></font></td>
</tr></table>`,
  );
}

/** The accounts grid - nested one frame deeper than the detail page. */
export function accountsFrame(v: Variant, m: Member): string {
  const rows = m.accounts
    .map(
      (a) => `<tr>
      <td><font ${FONT}>${esc(a.kind === "Savings" ? v.savingsRowLabel : a.kind)}</font></td>
      <td><font ${FONT}>${esc(a.accountNumber)}</font></td>
      <td align="right"><font ${FONT}>${esc(money(a.balance))}</font></td>
      <td><font ${FONT}>${esc(a.status)}</font></td>
    </tr>`,
    )
    .join("\n");
  return page(
    v,
    "Accounts",
    `<table class="grid" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <th><font ${FONT}>Account Type</font></th>
        <th><font ${FONT}>Account Number</font></th>
        <th><font ${FONT}>${esc(v.balanceColumnHeader)}</font></th>
        <th><font ${FONT}>Status</font></th>
      </tr>
      ${rows}
    </table>`,
  );
}

/* ------------------------------------------------- exceptional-state pages */

export function permissionDenied(v: Variant, memberId: string): string {
  return page(
    v,
    `${v.brand} - Access Denied`,
    `<table width="100%" cellpadding="0" cellspacing="0"><tr><td class="hdr"><font ${FONT} color="#ffffff">Access Denied</font></td></tr></table>
<table cellpadding="8"><tr><td>
  <font ${FONT} class="err">You are not authorized to view this member record.</font><br><br>
  <font ${FONT}>Member ${esc(memberId)} is flagged for Executive Services. Contact your supervisor for elevation.</font><br><br>
  <font ${FONT}>Reference: SEC-4031</font><br><br>
  <font ${FONT}><a href="/frame/search?variant=${v.id}">New Search</a></font>
</td></tr></table>`,
  );
}

export function loginInterstitial(v: Variant, returnTo: string): string {
  const p = v.ctlPrefix;
  return page(
    v,
    `${v.brand} - Session Expired`,
    `<table width="100%" cellpadding="0" cellspacing="0"><tr><td class="hdr"><font ${FONT} color="#ffffff">Session Expired</font></td></tr></table>
<form method="post" action="/frame/login">
<input type="hidden" name="returnTo" value="${esc(returnTo)}">
<input type="hidden" name="variant" value="${esc(v.id)}">
<table cellpadding="8"><tr><td>
  <font ${FONT} class="err">Your session has timed out due to inactivity.</font><br><br>
  <table cellpadding="2" cellspacing="0" border="0">
    <tr><td class="lbl"><font ${FONT}>Operator ID</font></td>
        <td class="fld"><input type="text" name="operator" id="${p}_txtOp" size="18" value="svc.automation"></td></tr>
  </table><br>
  <input type="submit" id="${p}_btnResume" value="Resume Session">
</td></tr></table>
</form>`,
  );
}

/** The unexpected confirmation dialog that appears on a fraction of loads. */
export function interstitialDialog(v: Variant, continueUrl: string): string {
  return page(
    v,
    `${v.brand} - Notice`,
    `<table width="100%" cellpadding="0" cellspacing="0"><tr><td class="hdr"><font ${FONT} color="#ffffff">System Notice</font></td></tr></table>
<table cellpadding="8"><tr><td>
  <font ${FONT}><b>Scheduled maintenance window</b></font><br><br>
  <font ${FONT}>Core processing will be unavailable Sunday 02:00&ndash;04:00 ET.
  Acknowledge this notice to continue.</font><br><br>
  <input type="button" id="${v.ctlPrefix}_btnAck" value="Acknowledge" onclick="location='${esc(continueUrl)}'">
</td></tr></table>`,
  );
}

export function appError(v: Variant, ref: string): string {
  return page(
    v,
    "Server Error",
    `<table cellpadding="8"><tr><td>
  <font ${FONT} size="4" class="err">Server Error in '/' Application.</font><hr>
  <font ${FONT}>Object reference not set to an instance of an object.</font><br><br>
  <font ${FONT}>Correlation Id: ${esc(ref)}</font>
</td></tr></table>`,
  );
}

export function unavailable(v: Variant): string {
  return page(
    v,
    "Unavailable",
    `<table cellpadding="8"><tr><td><font ${FONT}>This module is not licensed for your institution.</font></td></tr></table>`,
  );
}

/* ------------------------------------------------------------ sub-account */

export interface SubAccountDraft {
  readonly kind: string;
  readonly nickname: string;
  readonly initialDeposit: string;
}

export function subAccountForm(
  v: Variant,
  m: Member,
  draft: Partial<SubAccountDraft>,
  errors: readonly string[],
): string {
  const p = v.ctlPrefix;
  const val = (s: string | undefined) => esc(s ?? "");
  return page(
    v,
    `${v.brand} - Open Sub-Account`,
    `<table width="100%" cellpadding="0" cellspacing="0"><tr><td class="hdr"><font ${FONT} color="#ffffff">Open Sub-Account - ${esc(m.memberId)}</font></td></tr></table>
<form method="post" action="/frame/subaccount/${esc(m.memberId)}">
<input type="hidden" name="variant" value="${esc(v.id)}">
<table cellpadding="0" cellspacing="0"><tr><td>
  <table class="panel" cellpadding="0" cellspacing="0"><tr><td>
    <table cellpadding="2" cellspacing="0" border="0">
      <tr><td colspan="2" height="6"></td></tr>
      <tr><td class="lbl"><font ${FONT}>Account Type</font></td>
          <td class="fld"><select name="kind" id="${p}_ddl1">
            <option value="">-- select --</option>
            <option value="Savings"${draft.kind === "Savings" ? " selected" : ""}>${esc(v.savingsRowLabel)}</option>
            <option value="Certificate"${draft.kind === "Certificate" ? " selected" : ""}>Certificate</option>
          </select></td></tr>
      <tr><td class="lbl"><font ${FONT}>Nickname</font></td>
          <td class="fld"><input type="text" name="nickname" id="${p}_txt11" size="24" value="${val(draft.nickname)}"></td></tr>
      <tr><td class="lbl"><font ${FONT}>Initial Deposit</font></td>
          <td class="fld"><input type="text" name="initialDeposit" id="${p}_txt12" size="12" value="${val(draft.initialDeposit)}"></td></tr>
      <tr><td></td><td class="fld"><input type="submit" id="${p}_btnSubmit" value="Continue"></td></tr>
      ${errors.map((e) => `<tr><td colspan="2" class="fld"><font ${FONT} class="err">${esc(e)}</font></td></tr>`).join("")}
      <tr><td colspan="2" height="6"></td></tr>
    </table>
  </td></tr></table>
</td></tr></table>
</form>`,
  );
}

/** Variant B only: an extra review screen before the irreversible commit. */
export function subAccountReview(v: Variant, m: Member, draft: SubAccountDraft): string {
  return page(
    v,
    `${v.brand} - Review Sub-Account`,
    `<table width="100%" cellpadding="0" cellspacing="0"><tr><td class="hdr"><font ${FONT} color="#ffffff">Review Request</font></td></tr></table>
<form method="post" action="/frame/subaccount/${esc(m.memberId)}/commit">
<input type="hidden" name="variant" value="${esc(v.id)}">
<input type="hidden" name="kind" value="${esc(draft.kind)}">
<input type="hidden" name="nickname" value="${esc(draft.nickname)}">
<input type="hidden" name="initialDeposit" value="${esc(draft.initialDeposit)}">
<table cellpadding="8"><tr><td>
  <font ${FONT}>Please review the details below before committing.</font><br><br>
  <table class="grid" cellpadding="0" cellspacing="0">
    <tr><th><font ${FONT}>Field</font></th><th><font ${FONT}>Value</font></th></tr>
    <tr><td><font ${FONT}>Account Type</font></td><td><font ${FONT}>${esc(draft.kind)}</font></td></tr>
    <tr><td><font ${FONT}>Nickname</font></td><td><font ${FONT}>${esc(draft.nickname)}</font></td></tr>
    <tr><td><font ${FONT}>Initial Deposit</font></td><td><font ${FONT}>${esc(draft.initialDeposit)}</font></td></tr>
  </table><br>
  <input type="submit" id="${v.ctlPrefix}_btnCommit" value="Commit Sub-Account">
</td></tr></table>
</form>`,
  );
}

export function subAccountConfirmation(
  v: Variant,
  m: Member,
  draft: SubAccountDraft,
  newAccountNumber: string,
): string {
  return page(
    v,
    `${v.brand} - Sub-Account Opened`,
    `<table width="100%" cellpadding="0" cellspacing="0"><tr><td class="hdr"><font ${FONT} color="#ffffff">Confirmation</font></td></tr></table>
<table cellpadding="8"><tr><td>
  <font ${FONT}><b>Sub-account opened successfully.</b></font><br><br>
  <table class="grid" cellpadding="0" cellspacing="0">
    <tr><th><font ${FONT}>Field</font></th><th><font ${FONT}>Value</font></th></tr>
    <tr><td><font ${FONT}>New Account Number</font></td><td><font ${FONT}>${esc(newAccountNumber)}</font></td></tr>
    <tr><td><font ${FONT}>Account Type</font></td><td><font ${FONT}>${esc(draft.kind)}</font></td></tr>
    <tr><td><font ${FONT}>Nickname</font></td><td><font ${FONT}>${esc(draft.nickname)}</font></td></tr>
    <tr><td><font ${FONT}>Member</font></td><td><font ${FONT}>${esc(m.memberId)}</font></td></tr>
  </table><br>
  <font ${FONT}><a href="/frame/member/${esc(m.memberId)}?variant=${v.id}">Return to Member</a></font>
</td></tr></table>`,
  );
}
