/**
 * Redaction as a pipeline stage, not a sprinkle.
 *
 * A Redactor sits between the raw world and EVERY sink: model prompts, run
 * logs, artifacts, and screenshots. The design intent is that there is no code
 * path where raw page text reaches a sink without passing through here, so the
 * question "could a card number end up in a log?" has one place to look.
 *
 * Two mechanisms, because neither alone is sufficient:
 *
 *   - pattern-based, for data we did not know was there (a member's SSN sitting
 *     in a page the automation merely passed through);
 *   - schema-driven, for data we did know (anything an artifact input declares
 *     as `pii` or `secret` is referenced by token and never inlined).
 *
 * Its limits are stated plainly in REPORT.md: regexes miss things, and
 * screenshot masking is only as good as the element flagging that drives it.
 */

import type { Bounds, UIElement, UISnapshot } from "../surface/types.js";

export interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
  /** Optional second gate, e.g. Luhn for card numbers, to cut false positives. */
  readonly validate?: (match: string) => boolean;
}

export const DEFAULT_RULES: readonly RedactionRule[] = [
  { name: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    name: "card_pan",
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    validate: (m) => luhn(m.replace(/[^\d]/g, "")),
  },
  // The account-number shape this vendor product uses: 4417-99820-01.
  { name: "account_number", pattern: /\b\d{4}-\d{4,6}-\d{2}\b/g },
  { name: "email", pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { name: "phone", pattern: /\b(?:\+1[ -]?)?\(?\d{3}\)?[ -]\d{3}-\d{4}\b/g },
  { name: "dob", pattern: /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g },
];

function luhn(digits: string): boolean {
  if (digits.length < 13) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export interface RedactionReport {
  /** rule name → how many values it masked. Written into the run log so the
   *  redaction pipeline is itself observable. */
  readonly counts: Readonly<Record<string, number>>;
}

export class Redactor {
  private readonly rules: readonly RedactionRule[];
  /** Exact values that must never appear anywhere: credentials, tokens, and the
   *  concrete values of inputs declared `pii` or `secret`. */
  private readonly literals = new Map<string, string>();
  private counts: Record<string, number> = {};

  constructor(rules: readonly RedactionRule[] = DEFAULT_RULES) {
    this.rules = rules;
  }

  /**
   * Register a value that must be replaced by a token wherever it appears.
   * This is how a credential reaches the browser without reaching the model:
   * the value is typed into the page, and every sink sees `{{secret:password}}`.
   */
  registerLiteral(value: string, token: string): void {
    if (value.length >= 3) this.literals.set(value, token);
  }

  redactText(input: string): string {
    if (input === "") return input;
    let out = input;

    for (const [value, token] of this.literals) {
      if (out.includes(value)) {
        out = out.split(value).join(token);
        this.bump("declared_literal");
      }
    }

    for (const rule of this.rules) {
      out = out.replace(rule.pattern, (match) => {
        if (rule.validate && !rule.validate(match)) return match;
        this.bump(rule.name);
        return `[REDACTED:${rule.name}]`;
      });
    }
    return out;
  }

  /** True when this element's own text or value carries something sensitive. */
  isSensitive(el: UIElement): boolean {
    const probe = `${el.name} ${el.value ?? ""} ${el.nearbyText.rowKey ?? ""}`;
    return this.redactText(probe) !== probe;
  }

  /**
   * Redact a snapshot before it reaches the model or the log. Element geometry
   * of anything sensitive is retained separately so screenshots can be masked.
   */
  redactSnapshot(snapshot: UISnapshot): { snapshot: UISnapshot; sensitiveBounds: Bounds[] } {
    const sensitiveBounds: Bounds[] = [];
    const elements = snapshot.elements.map((el) => {
      const name = this.redactText(el.name);
      const value = el.value === undefined ? undefined : this.redactText(el.value);
      const nearbyText = {
        leftCell: maybe(el.nearbyText.leftCell, (s) => this.redactText(s)),
        aboveCell: maybe(el.nearbyText.aboveCell, (s) => this.redactText(s)),
        precedingText: maybe(el.nearbyText.precedingText, (s) => this.redactText(s)),
        columnHeader: maybe(el.nearbyText.columnHeader, (s) => this.redactText(s)),
        rowKey: maybe(el.nearbyText.rowKey, (s) => this.redactText(s)),
      };
      const changed = name !== el.name || value !== el.value;
      if (changed && el.bounds) sensitiveBounds.push(el.bounds);
      return { ...el, name, value, nearbyText };
    });

    return {
      snapshot: {
        ...snapshot,
        page: { ...snapshot.page, title: this.redactText(snapshot.page.title) },
        elements,
      },
      sensitiveBounds,
    };
  }

  /** Deep-redact any JSON-serializable structure destined for a log or artifact. */
  redactJson<T>(value: T): T {
    if (typeof value === "string") return this.redactText(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.redactJson(v)) as unknown as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactJson(v);
      return out as T;
    }
    return value;
  }

  report(): RedactionReport {
    return { counts: { ...this.counts } };
  }

  resetCounts(): void {
    this.counts = {};
  }

  private bump(rule: string): void {
    this.counts[rule] = (this.counts[rule] ?? 0) + 1;
  }
}

function maybe(v: string | undefined, fn: (s: string) => string): string | undefined {
  return v === undefined ? undefined : fn(v);
}
