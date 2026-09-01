/**
 * The tool surface the model drives.
 *
 * Two deliberate properties.
 *
 * First, it mirrors SurfaceAction rather than the DOM. The model never sees
 * HTML, never writes a selector, and never gets coordinates — it picks a ref
 * out of a normalized snapshot. That is what makes the recorded flow portable
 * to a surface Playwright cannot drive.
 *
 * Second, `type` takes EITHER a literal `text` OR a `param` name, never a
 * literal that happens to equal a parameter value. This is how parameterization
 * gets provenance: when the compiler sees a step bound to `param: "memberId"`
 * it KNOWS that value came from an input, instead of string-matching "10042"
 * across the transcript and hoping it never collides with a balance, a date, or
 * an account suffix. Secrets and PII ride the same path, so their values reach
 * the browser without ever reaching the model.
 */

import type { ToolSpec } from "./llm.js";

const str = (description: string) => ({ type: "string", description });

export const DISCOVERY_TOOLS: readonly ToolSpec[] = [
  {
    name: "click",
    description: "Click an element from the current snapshot, by its ref.",
    parameters: {
      type: "object",
      properties: {
        ref: str("element ref, e.g. e12"),
        why: str("one sentence: why this advances the goal"),
      },
      required: ["ref", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "type",
    description:
      "Type into a textbox. Supply EITHER text (a literal) OR param (the name of a goal input " +
      "whose value should be filled in). Prefer param whenever the value came from the task inputs.",
    parameters: {
      type: "object",
      properties: {
        ref: str("element ref"),
        text: str("literal text to type; omit if using param"),
        param: str("name of an input parameter to bind; omit if using text"),
        submit: { type: "boolean", description: "press Enter after typing" },
        why: str("one sentence rationale"),
      },
      required: ["ref", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "select",
    description:
      "Choose an option in a combobox. Supply EITHER option (a literal visible label) OR param " +
      "(the name of a goal input holding the label). Prefer param whenever the choice came from " +
      "the task inputs — a hard-coded product type would make the capability only able to open " +
      "that one product.",
    parameters: {
      type: "object",
      properties: {
        ref: str("element ref"),
        option: str("literal visible option label; omit if using param"),
        param: str("name of an input parameter to bind; omit if using option"),
        why: str("rationale"),
      },
      required: ["ref", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "navigate",
    description: "Go to a URL. Only used to reach the entry point; prefer clicking within the app.",
    parameters: {
      type: "object",
      properties: { url: str("absolute URL"), why: str("rationale") },
      required: ["url", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "read",
    description: "Read the text of an element without changing anything.",
    parameters: {
      type: "object",
      properties: { ref: str("element ref"), why: str("rationale") },
      required: ["ref", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "extract_output",
    description:
      "Declare that an element holds a value the caller wants back. Call this for every output " +
      "the goal asks for, before declaring success.",
    parameters: {
      type: "object",
      properties: {
        name: str("output name in snake_case, e.g. savings_balance"),
        ref: str("element ref holding the value"),
        parse: {
          type: "string",
          enum: ["text", "currency"],
          description: "how to parse the value",
        },
        why: str("rationale"),
      },
      required: ["name", "ref", "parse", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "note_known_outcome",
    description:
      "Record that the app is showing a legitimate business outcome (not found, permission " +
      "denied, validation error) rather than a malfunction. Use the visible message as evidence.",
    parameters: {
      type: "object",
      properties: {
        code: str("stable snake_case code, e.g. member_not_found"),
        severity: { type: "string", enum: ["business", "recoverable", "hard"] },
        evidence_text: str("exact text on screen that identifies this condition"),
        message: str("what a caller should be told"),
        why: str("rationale"),
      },
      required: ["code", "severity", "evidence_text", "message", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "declare_success",
    description: "The goal is achieved and the current screen proves it.",
    parameters: {
      type: "object",
      properties: {
        evidence_text: str("text visible on the current screen that proves the goal was reached"),
        why: str("rationale"),
      },
      required: ["evidence_text", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "request_human_help",
    description:
      "Stop and hand control to a human operator. Use when stuck or when an action looks unsafe.",
    parameters: {
      type: "object",
      properties: { reason: str("what you tried and why you cannot proceed") },
      required: ["reason"],
      additionalProperties: false,
    },
  },
];
