export type ErrorCode =
  | 'usage'
  | 'not_twake_domain'
  | 'network'
  | 'unavailable'
  | 'bad_response'
  | 'insecure_endpoint'
  | 'login_required'
  | 'login_cancelled'
  | 'ports_busy'
  | 'lock_timeout'
  | 'insecure_file'
  | 'damaged_file'
  | 'keychain'
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
