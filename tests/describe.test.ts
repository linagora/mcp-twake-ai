import { describe, expect, it } from 'vitest';
import { describeError } from '../src/describe.js';
import { HttpError } from '../src/http.js';

describe('describeError', () => {
  it("says what the identity provider explained, not only its error code", () => {
    const error = new HttpError(400, 'https://sso.linagora.com/oauth2/device', JSON.stringify({ error: 'invalid_request', error_description: 'code_challenge is required' }));
    expect(describeError(error)).toBe('sso.linagora.com refused the request (HTTP 400, invalid_request: code_challenge is required).');
  });
});
