/**
 * Server-side LLM provider abstraction. The API key is read from the
 * environment here and NEVER leaves the server. Swap providers by adding a
 * class that implements AiProvider and returning it from getAiProvider().
 */
export interface AiCompletionRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AiProvider {
  readonly name: string;
  complete(req: AiCompletionRequest): Promise<string>;
}

export class AiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiError";
  }
}

const TIMEOUT_MS = 25_000;

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Never echo the response body: it could contain request echoes.
      throw new AiError(`AI provider returned HTTP ${res.status}`);
    }
    return await res.json();
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError(e instanceof Error && e.name === "AbortError" ? "AI provider timed out" : "AI provider request failed");
  } finally {
    clearTimeout(timer);
  }
}

class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  constructor(private apiKey: string, private model: string, private baseUrl: string) {}
  async complete(req: AiCompletionRequest): Promise<string> {
    const json = await postJson(
      `${this.baseUrl}/v1/messages`,
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      },
    );
    const text = (json?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    if (!text) throw new AiError("AI provider returned an empty response");
    return text;
  }
}

class OpenAiCompatibleProvider implements AiProvider {
  readonly name = "openai";
  constructor(private apiKey: string, private model: string, private baseUrl: string) {}
  async complete(req: AiCompletionRequest): Promise<string> {
    const json = await postJson(
      `${this.baseUrl}/v1/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      },
    );
    const text = json?.choices?.[0]?.message?.content;
    if (!text) throw new AiError("AI provider returned an empty response");
    return String(text);
  }
}

/** Returns null when no key is configured (the app then runs fully deterministic/local). */
export function getAiProvider(): AiProvider | null {
  const key = process.env.AI_API_KEY?.trim();
  if (!key) return null;
  const provider = (process.env.AI_PROVIDER || "anthropic").toLowerCase();
  const model = process.env.AI_MODEL?.trim();
  if (provider === "openai") {
    return new OpenAiCompatibleProvider(key, model || "gpt-4o-mini", (process.env.AI_BASE_URL || "https://api.openai.com").replace(/\/$/, ""));
  }
  return new AnthropicProvider(key, model || "claude-sonnet-5", (process.env.AI_BASE_URL || "https://api.anthropic.com").replace(/\/$/, ""));
}

export function aiConfigured(): boolean {
  return !!process.env.AI_API_KEY?.trim();
}

/** Extract the first JSON object/array from a model response (tolerates code fences / prose). */
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const open = candidate[start];
  const close = open === "[" ? "]" : "}";
  const end = candidate.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
