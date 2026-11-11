import { TwakeAiError } from './errors.js';
import { hostOf, HttpError } from './http.js';

/** One line for the user (an MCP server shows only the last line of stderr). Usage errors keep the usage text. */
export function describeError(error: unknown): string {
  if (error instanceof TwakeAiError) return error.message;
  if (error instanceof HttpError) {
    return `${hostOf(error.url)} refused the request (HTTP ${error.status}${error.oauthError ? `, ${error.oauthError}` : ''}).`;
  }
  return `unexpected error: ${String((error as Error)?.message ?? error).split('\n')[0]}`;
}
