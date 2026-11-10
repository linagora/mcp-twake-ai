export type ErrorCode =
  | 'usage'
  | 'not_twake_domain'
  | 'network'
  | 'bad_response'
  | 'login_required'
  | 'login_cancelled'
  | 'ports_busy'
  | 'lock_timeout'
  | 'insecure_file'
  | 'unsupported';

/** An error whose message is written for the user: the CLI prints it as is. */
export class TwakeAiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TwakeAiError';
  }
}
