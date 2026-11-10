import type { z } from 'zod';
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** HTTPS everywhere; plain http only towards this computer (tests, local development), as the Twake.ai MCP servers do. */
export function isSecureUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname));
  } catch {
    return false;
  }
}

/** Returns `url` when it is secure, else refuses it, naming `what` it was meant to be. */
export function requireSecureUrl(url: string, what: string): string {
  if (isSecureUrl(url)) return url;
  throw new TwakeAiError('insecure_endpoint', `${what} must use HTTPS: refusing ${url}`);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** fetch with a timeout; a network failure becomes a `network` error that names the host and the low-level cause. */
export async function send(url: string, init: RequestInit, options: HttpOptions = {}): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  try {
    return await doFetch(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
    const detail = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : undefined;
    throw new TwakeAiError('network', `Cannot reach ${hostOf(url)}: ${(error as Error).message}${detail ? ` (${detail})` : ''}`);
  }
}

export async function requestJson(url: string, init: RequestInit, options: HttpOptions = {}): Promise<unknown> {
  const headers = { accept: 'application/json', ...(init.headers as Record<string, string> | undefined) };
  const response = await send(url, { ...init, headers }, options);
  if (response.redirected) requireSecureUrl(response.url, `The redirect of ${url}`);
  const body = await response.text();
  if (response.status >= 300 && response.status < 400) {
    throw new TwakeAiError('bad_response', `${url} answered a redirect (HTTP ${response.status}), which twake-ai does not follow for this request.`);
  }
  if (response.status >= 500 || response.status === 408 || response.status === 429) {
    throw new TwakeAiError('unavailable', `${hostOf(url)} is unavailable right now (HTTP ${response.status}): try again in a moment.`);
  }
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

/** POST without following redirects: the form may carry a refresh token or a code verifier. */
export function postForm(url: string, form: Record<string, string>, options?: HttpOptions): Promise<unknown> {
  return requestJson(
    url,
    {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    },
    options,
  );
}

/** Validates a server answer; a mismatch becomes one readable line that names the URL. */
export function parseAnswer<T>(schema: z.ZodType<T>, raw: unknown, url: string): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? issue.path.join('.') : 'body';
  throw new TwakeAiError('bad_response', `${url} answered something twake-ai cannot read (${where}: ${issue?.message ?? 'invalid'}).`);
}
