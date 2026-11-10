import { TwakeAiError } from './errors.js';

export interface HttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
  }

  /** The OAuth `error` code of the body (RFC 6749 §5.2), if any. */
  get oauthError(): string | undefined {
    try {
      const parsed = JSON.parse(this.body) as { error?: unknown };
      return typeof parsed.error === 'string' ? parsed.error : undefined;
    } catch {
      return undefined;
    }
  }
}

/** fetch with a timeout; a network failure becomes a `network` error that names the host. */
export async function send(url: string, init: RequestInit, options: HttpOptions = {}): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  try {
    return await doFetch(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
  } catch (error) {
    throw new TwakeAiError('network', `Cannot reach ${new URL(url).host}: ${(error as Error).message}`);
  }
}

export async function requestJson(url: string, init: RequestInit, options: HttpOptions = {}): Promise<unknown> {
  const headers = { accept: 'application/json', ...(init.headers as Record<string, string> | undefined) };
  const response = await send(url, { ...init, headers }, options);
  const body = await response.text();
  if (!response.ok) throw new HttpError(response.status, url, body);
  if (!body) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new TwakeAiError('bad_response', `${url} did not answer JSON`);
  }
}

export function getJson(url: string, options?: HttpOptions, headers: Record<string, string> = {}): Promise<unknown> {
  return requestJson(url, { method: 'GET', headers }, options);
}

export function postForm(url: string, form: Record<string, string>, options?: HttpOptions): Promise<unknown> {
  return requestJson(
    url,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() },
    options,
  );
}
