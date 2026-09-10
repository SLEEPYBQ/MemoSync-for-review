

export interface DeepSeekJsonRequest {
  system: string;
  user: string;

  maxTokens?: number;
  timeoutMs?: number;


  disableThinking?: boolean;


  reasoningEffort?: 'low' | 'high' | 'max';

  signal?: AbortSignal;
}


export type LlmJsonCaller = (req: DeepSeekJsonRequest) => Promise<Record<string, unknown>>;


export type LlmFailureCategory =
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'provider_5xx'
  | 'provider_4xx'
  | 'empty_response'
  | 'truncated'
  | 'invalid_json'
  | 'invalid_response'
  | 'unknown';

export class LlmJsonError extends Error {
  constructor(
    message: string,
    readonly category: LlmFailureCategory,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'LlmJsonError';
  }
}

export function describeLlmJsonFailure(error: unknown): {
  category: LlmFailureCategory;
  httpStatus?: number;
} {
  if (error instanceof LlmJsonError) {
    return {
      category: error.category,
      ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
    };
  }
  return { category: 'unknown' };
}

export interface DeepSeekCallerOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;

  maxRetries?: number;

  retryDelayMs?: number;
}


const DEFAULT_MAX_TOKENS = 4000;


const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;


class TransientLlmError extends LlmJsonError {}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());


function unfence(text: string): string {
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  return m ? m[1] : text;
}


export function createDeepSeekJsonCaller(opts: DeepSeekCallerOptions = {}): LlmJsonCaller | null {
  const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
  if (!apiKey) return null;
  const baseUrl = (opts.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const model = opts.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;


  const attempt = async (req: DeepSeekJsonRequest): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        signal: req.signal
          ? AbortSignal.any([AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS), req.signal])
          : AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          response_format: { type: 'json_object' },
          ...(req.disableThinking ? { thinking: { type: 'disabled' } } : {}),
          ...(req.reasoningEffort && !req.disableThinking ? { reasoning_effort: req.reasoningEffort } : {}),
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
      });
    } catch (error) {

      if (req.signal?.aborted) {
        throw new LlmJsonError('DeepSeek request cancelled', 'cancelled');
      }
      const category = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? 'timeout'
        : 'network';
      throw new TransientLlmError(
        category === 'timeout' ? 'DeepSeek request timed out' : 'DeepSeek network request failed',
        category,
      );
    }
    if (!res.ok) {
      if (res.status === 429) {
        throw new TransientLlmError(`DeepSeek HTTP ${res.status}`, 'rate_limited', res.status);
      }
      if (res.status >= 500) {
        throw new TransientLlmError(`DeepSeek HTTP ${res.status}`, 'provider_5xx', res.status);
      }
      throw new LlmJsonError(`DeepSeek HTTP ${res.status}`, 'provider_4xx', res.status);
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const content = body.choices?.[0]?.message?.content ?? '';
    if (!content.trim()) throw new TransientLlmError('DeepSeek returned empty content', 'empty_response');


    if (body.choices?.[0]?.finish_reason === 'length') {
      throw new LlmJsonError(
        `DeepSeek output truncated at max_tokens=${req.maxTokens ?? DEFAULT_MAX_TOKENS}`,
        'truncated',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(unfence(content));
    } catch {
      throw new LlmJsonError('DeepSeek returned invalid JSON', 'invalid_json');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LlmJsonError('DeepSeek returned non-object JSON', 'invalid_response');
    }
    return parsed as Record<string, unknown>;
  };

  return async (req: DeepSeekJsonRequest): Promise<Record<string, unknown>> => {
    let lastError: unknown;
    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await attempt(req);
      } catch (error) {
        lastError = error;

        if (req.signal?.aborted) throw error;
        if (!(error instanceof TransientLlmError) || i === maxRetries) throw error;
        await sleep(retryDelayMs * (i + 1));
      }
    }
    throw lastError;
  };
}
