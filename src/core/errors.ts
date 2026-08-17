export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class AuthRequiredError extends BridgeError {
  constructor(public readonly providerId: string) {
    super(`${providerId} not authenticated. Open Dashboard to login.`);
  }
}

export class AuthExpiredError extends BridgeError {
  constructor(public readonly providerId: string) {
    super(`${providerId} authentication expired. Open Dashboard to re-login.`);
  }
}

export class InvalidModelError extends BridgeError {
  constructor(public readonly modelId: string) {
    super(`Invalid model: "${modelId}". Format: {provider}/{model}`);
  }
}

export class ProviderDisabledError extends BridgeError {
  constructor(public readonly providerId: string) {
    super(`Provider "${providerId}" is not enabled.`);
  }
}

export class InvalidBodyError extends BridgeError {
  constructor(detail: string) {
    super(`Invalid request body: ${detail}`);
  }
}

export class InvalidTokenError extends BridgeError {
  constructor() {
    super('Invalid or missing Bearer token.');
  }
}

export class BrowserUnavailableError extends BridgeError {
  constructor(detail: string) {
    super(`Browser unavailable: ${detail}`);
  }
}

export class UpstreamRateLimitError extends BridgeError {
  constructor(public readonly providerId: string) {
    super(`${providerId} rate limited by upstream.`);
  }
}

export class UpstreamBlockedError extends BridgeError {
  constructor(public readonly providerId: string) {
    super(`${providerId} blocked by upstream (Cloudflare or similar).`);
  }
}

export class TimeoutError extends BridgeError {
  constructor(public readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms.`);
  }
}

export interface ErrorResponse {
  status: number;
  body: {
    error: {
      message: string;
      type: string;
      code: string;
      param: null;
    };
  };
}

/**
 * Single source of truth for error code → HTTP status / error type mapping.
 * Used both when converting thrown errors and when converting StreamEvent
 * error events produced by the Router.
 */
const ERROR_CODE_INFO: Record<string, { status: number; type: string }> = {
  auth_required: { status: 401, type: 'authentication_error' },
  auth_expired: { status: 401, type: 'authentication_error' },
  invalid_model: { status: 400, type: 'invalid_request_error' },
  invalid_body: { status: 400, type: 'invalid_request_error' },
  invalid_token: { status: 403, type: 'permission_error' },
  provider_disabled: { status: 404, type: 'not_found_error' },
  browser_unavailable: { status: 503, type: 'server_error' },
  upstream_rate_limit: { status: 429, type: 'rate_limit_error' },
  upstream_blocked: { status: 502, type: 'server_error' },
  timeout: { status: 504, type: 'server_error' },
  internal_error: { status: 500, type: 'server_error' },
};

export function errorEventToResponse(code: string | undefined, message: string): ErrorResponse {
  const info = code ? ERROR_CODE_INFO[code] : undefined;
  const resolvedCode = code && info ? code : 'internal_error';
  return {
    status: info?.status ?? 500,
    body: {
      error: {
        message,
        type: info?.type ?? 'server_error',
        code: resolvedCode,
        param: null,
      },
    },
  };
}

export function errorToHttpResponse(err: Error): ErrorResponse {
  const code =
    err instanceof AuthRequiredError ? 'auth_required'
      : err instanceof AuthExpiredError ? 'auth_expired'
      : err instanceof InvalidModelError ? 'invalid_model'
      : err instanceof InvalidBodyError ? 'invalid_body'
      : err instanceof InvalidTokenError ? 'invalid_token'
      : err instanceof ProviderDisabledError ? 'provider_disabled'
      : err instanceof BrowserUnavailableError ? 'browser_unavailable'
      : err instanceof UpstreamRateLimitError ? 'upstream_rate_limit'
      : err instanceof UpstreamBlockedError ? 'upstream_blocked'
      : err instanceof TimeoutError ? 'timeout'
      : 'internal_error';
  return errorEventToResponse(code, err.message);
}