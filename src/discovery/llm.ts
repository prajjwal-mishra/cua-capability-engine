/**
 * Provider-agnostic LLM client.
 *
 * Bound to the OpenAI chat-completions + tool-calling shape rather than to one
 * vendor's SDK. That is not fence-sitting: this system uses the model for
 * exactly one job - pick the next action from a normalized snapshot - and every
 * serious provider exposes that job through this interface. Coupling the
 * discovery loop to a single vendor would buy nothing and cost us the ability
 * to run at all when one provider is unavailable, which is not hypothetical.
 *
 * Configured entirely by env: CUA_LLM_BASE_URL / _API_KEY / _MODEL.
 */

import OpenAI from "openai";

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface LlmTurn {
  readonly toolCalls: readonly LlmToolCall[];
  readonly text?: string;
}

export interface LlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export function llmConfigFromEnv(): LlmConfig {
  const baseUrl = process.env.CUA_LLM_BASE_URL ?? "";
  const apiKey = process.env.CUA_LLM_API_KEY ?? "";
  const model = process.env.CUA_LLM_MODEL ?? "";
  if (!baseUrl || !model) {
    throw new Error(
      "discovery needs an LLM: set CUA_LLM_BASE_URL, CUA_LLM_API_KEY and CUA_LLM_MODEL in .env " +
        "(any OpenAI-compatible endpoint). Replay, catalog and tests run without it.",
    );
  }
  return { baseUrl, apiKey, model };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string };

export class LlmClient {
  private readonly client: OpenAI;

  constructor(private readonly config: LlmConfig) {
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || "not-needed",
      maxRetries: 2,
      // Gateways that front free upstream pools tend to stall rather than
      // error. Without an explicit ceiling a dead provider hangs the run
      // instead of failing it, which is the worst of both outcomes.
      timeout: Number(process.env.CUA_LLM_TIMEOUT_MS ?? 90_000),
    });
  }

  get model(): string {
    return this.config.model;
  }

  async next(messages: readonly ChatMessage[], tools: readonly ToolSpec[]): Promise<LlmTurn> {
    const res = await this.client.chat.completions.create({
      model: this.config.model,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      tools: tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: "auto",
      temperature: 0,
      max_tokens: 1024,
    });

    const choice = res.choices[0]?.message;
    const toolCalls: LlmToolCall[] = [];
    for (const call of choice?.tool_calls ?? []) {
      if (call.type !== "function") continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        // A malformed tool call is a model error, not a crash: surface it as an
        // empty-arg call so the loop can tell the model what went wrong.
        args = { __parseError: call.function.arguments };
      }
      toolCalls.push({ id: call.id, name: call.function.name, args });
    }

    return { toolCalls, text: choice?.content ?? undefined };
  }

  /** Cheap, non-agentic call used to label a finished run. */
  async label(prompt: string): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.config.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 400,
    });
    return res.choices[0]?.message?.content ?? "";
  }

  /**
   * Probe the endpoint before a browser is launched. Deliberately short and
   * non-retrying: the question is "is there a working model right now", and a
   * provider that needs three attempts and two minutes to answer is a no.
   */
  async healthCheck(timeoutMs = 20_000): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: [{ role: "user", content: "ok" }],
          max_tokens: 5,
        },
        { timeout: timeoutMs, maxRetries: 0 },
      );
      return { ok: true, detail: res.model ?? this.config.model };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
