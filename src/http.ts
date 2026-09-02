import type { Config } from './config.js';

/** Path prefix for Collectives v1 endpoints, appended after `/ocs/v2.php`. */
export const COLLECTIVES_API = '/apps/collectives/api/v1.0';

// -----------------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------------

const DEBUG = !!process.env.DEBUG;

function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[collectives-mcp] ${msg}\n`);
}

// -----------------------------------------------------------------------------
// Retry configuration
// -----------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
/** Upper bound on any single retry delay, including server-provided Retry-After. */
export const MAX_RETRY_DELAY_MS = 30_000;
/**
 * HTTP methods that may be repeated without changing the result beyond that of
 * a single call. Everything else (POST, COPY, and PUT page-copy) is retried
 * only when the server tells us it never processed the request (429).
 */
const IDEMPOTENT_METHODS = new Set([
  'GET',
  'HEAD',
  'OPTIONS',
  'PUT',
  'DELETE',
  'PROPFIND',
  'MKCOL',
  'MOVE',
]);

/**
 * A 5xx is ambiguous — the write may have been committed before the error.
 * Only replay it when replaying is harmless. A 429 is always safe to replay:
 * the server rejected the request outright.
 */
function isRetryable(status: number, idempotent: boolean): boolean {
  if (status === 429) return true;
  return idempotent && status >= 500 && status <= 599;
}

/**
 * Transient transport failures (connection reset, DNS blip, socket close).
 * Deliberately excludes AbortError: a request that hit its deadline is
 * reported to the caller rather than replayed.
 */
function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  const code = (err as { cause?: { code?: string } }).cause?.code;
  if (code) {
    return [
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EPIPE',
      'ETIMEDOUT',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
    ].includes(code);
  }
  // Undici surfaces network failures as a bare TypeError('fetch failed').
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff for the given zero-based attempt, capped. */
function backoffDelay(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
}

/** A request that exceeded its deadline. Never retried. */
export class TimeoutError extends Error {
  public readonly hint =
    'The Nextcloud server may be unreachable or overloaded. ' +
    'Raise NEXTCLOUD_TIMEOUT_MS if the operation is legitimately slow.';

  constructor(label: string, timeoutMs: number) {
    super(
      `Request timed out after ${timeoutMs}ms: ${label} ` +
        '[The Nextcloud server may be unreachable or overloaded. ' +
        'Raise NEXTCLOUD_TIMEOUT_MS if the operation is legitimately slow.]',
    );
    this.name = 'TimeoutError';
  }
}

/**
 * Parse a Retry-After header. Returns delay in milliseconds clamped to
 * {@link MAX_RETRY_DELAY_MS}, or null if the header is absent / unparseable.
 * The cap stops a hostile or misconfigured server from stalling the MCP
 * client indefinitely.
 */
function parseRetryAfter(res: Response): number | null {
  const header = res.headers.get('Retry-After');
  if (!header) return null;
  const clamp = (ms: number) => Math.min(Math.max(0, ms), MAX_RETRY_DELAY_MS);
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) return clamp(seconds * 1000);
  const date = Date.parse(header);
  if (!isNaN(date)) return clamp(date - Date.now());
  return null;
}

// -----------------------------------------------------------------------------
// Error classes
// -----------------------------------------------------------------------------

const ERROR_BODY_MAX = 200;

/** A failed HTTP response (non-2xx status). */
export class HttpError extends Error {
  /** Human-readable suggestion for how the caller might fix the problem. */
  public readonly hint: string;

  constructor(
    public readonly status: number,
    public readonly statusText: string,
    body: string,
  ) {
    const snippet = body.length > ERROR_BODY_MAX ? `${body.slice(0, ERROR_BODY_MAX)}…` : body;
    const hint = httpHint(status);
    super(`HTTP ${status} ${statusText}${snippet ? `: ${snippet}` : ''}${hint ? ` [${hint}]` : ''}`);
    this.name = 'HttpError';
    this.hint = hint;
  }
}

function httpHint(status: number): string {
  switch (status) {
    case 401: return 'Check NEXTCLOUD_APP_PASSWORD — it may be expired or revoked.';
    case 403: return 'The app-password lacks permission for this operation.';
    case 404: return 'Resource not found — the page/collective may have been deleted or the id is wrong.';
    case 405: return 'Method not allowed — this endpoint may not support this operation.';
    case 409: return 'Conflict — a resource with that name may already exist.';
    case 423: return 'Locked — the file is locked by another process or user.';
    case 429: return 'Rate-limited — too many requests. Retry later.';
    case 507: return 'Insufficient storage on the Nextcloud server.';
    default:
      if (status >= 500) return 'Server error — Nextcloud may be overloaded or misconfigured.';
      return '';
  }
}

/** A 2xx response that an OCS endpoint reports as a failure in its envelope. */
export class OcsError extends Error {
  public readonly hint: string;

  constructor(
    public readonly statuscode: number,
    message: string,
  ) {
    const hint = ocsHint(statuscode);
    super(`OCS ${statuscode}: ${message}${hint ? ` [${hint}]` : ''}`);
    this.name = 'OcsError';
    this.hint = hint;
  }
}

function ocsHint(code: number): string {
  switch (code) {
    case 997: return 'Not allowed — check permissions.';
    case 998: return 'Invalid query — the API endpoint or parameters are wrong.';
    case 999: return 'Not authenticated — check credentials.';
    default: return '';
  }
}

interface OcsEnvelope<T> {
  ocs: {
    meta: { status: string; statuscode: number; message?: string };
    data: T;
  };
}

export class NextcloudClient {
  private readonly authHeader: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: Config) {
    const token = Buffer.from(`${config.user}:${config.password}`, 'utf8').toString('base64');
    this.authHeader = `Basic ${token}`;
    this.timeoutMs = config.timeoutMs;
    if (config.url.startsWith('http://')) {
      process.stderr.write(
        '[collectives-mcp] WARNING: NEXTCLOUD_URL uses http:// — ' +
          'credentials will be sent in plain text. Use https:// in production.\n',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Shared retry logic
  // ---------------------------------------------------------------------------

  /**
   * Fetch with a per-request deadline and bounded retries.
   *
   * Retries exactly one delay per attempt: the server's `Retry-After` when it
   * supplies one, otherwise exponential backoff — both capped at
   * {@link MAX_RETRY_DELAY_MS}. 429 is retried for every method; 5xx and
   * transient network failures only for idempotent requests, so an ambiguous
   * write is never silently duplicated.
   *
   * @param accept207 Treat HTTP 207 Multi-Status as success (needed for WebDAV).
   * @param idempotentOverride Force the idempotency verdict when the method
   *   alone is misleading — e.g. the page-copy endpoint is a `PUT`.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    label: string,
    accept207 = false,
    idempotentOverride?: boolean,
  ): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const idempotent = idempotentOverride ?? IDEMPOTENT_METHODS.has(method);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      debug(attempt === 0 ? label : `Retry ${attempt}/${MAX_RETRIES} for ${label}`);

      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
          throw new TimeoutError(label, this.timeoutMs);
        }
        if (isTransientNetworkError(err) && idempotent && attempt < MAX_RETRIES) {
          lastError = err as Error;
          await sleep(backoffDelay(attempt));
          continue;
        }
        throw err;
      }

      const isSuccess = res.ok || (accept207 && res.status === 207);
      if (isSuccess) return res;

      const text = await res.text().catch(() => '');
      const httpError = new HttpError(res.status, res.statusText, text);

      if (isRetryable(res.status, idempotent) && attempt < MAX_RETRIES) {
        lastError = httpError;
        await sleep(parseRetryAfter(res) ?? backoffDelay(attempt));
        continue;
      }
      throw httpError;
    }
    throw lastError ?? new Error('Unexpected retry exhaustion');
  }

  // ---------------------------------------------------------------------------
  // OCS
  // ---------------------------------------------------------------------------

  /**
   * Call any OCS endpoint. `path` is appended after `/ocs/v2.php` and must
   * start with `/`. Returns the unwrapped `ocs.data` payload.
   */
  async ocs<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    idempotent?: boolean,
  ): Promise<T> {
    const url = `${this.config.url}/ocs/v2.php${path}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
      'OCS-APIRequest': 'true',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetchWithRetry(
      url,
      { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
      `${method} ${path}`,
      false,
      idempotent,
    );

    const text = await res.text();
    let parsed: OcsEnvelope<T>;
    try {
      parsed = JSON.parse(text) as OcsEnvelope<T>;
    } catch {
      throw new Error(`OCS response was not valid JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    const meta = parsed.ocs?.meta;
    if (!meta || meta.status !== 'ok') {
      throw new OcsError(meta?.statuscode ?? 0, meta?.message ?? 'OCS request failed');
    }
    return parsed.ocs.data;
  }

  // ---------------------------------------------------------------------------
  // WebDAV — user files
  // ---------------------------------------------------------------------------

  /**
   * Call a WebDAV endpoint under the user's Files area. `path` is appended to
   * `/remote.php/dav/files/{user}` and must start with `/`. Returns the raw
   * `Response`.
   */
  async webdav(
    method: string,
    path: string,
    body?: string | Uint8Array,
    extraHeaders: Record<string, string> = {},
    idempotent?: boolean,
  ): Promise<Response> {
    return this.fetchWithRetry(
      this.webdavUrl(path),
      { method, headers: { Authorization: this.authHeader, ...extraHeaders }, body },
      `WebDAV ${method} ${path}`,
      true,
      idempotent,
    );
  }

  /**
   * Absolute URL for a WebDAV path under the user's Files area. Needed for
   * the `Destination` header of MOVE / COPY requests, which must be a full URL.
   */
  webdavUrl(path: string): string {
    const userSegment = encodeURIComponent(this.config.user);
    return `${this.config.url}/remote.php/dav/files/${userSegment}${path}`;
  }

  // ---------------------------------------------------------------------------
  // WebDAV — file versions
  // ---------------------------------------------------------------------------

  /**
   * Call a WebDAV endpoint under the user's versions area. `path` is appended
   * to `/remote.php/dav/versions/{user}` and must start with `/`.
   */
  async webdavVersions(
    method: string,
    path: string,
    body?: string | Uint8Array,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const userSegment = encodeURIComponent(this.config.user);
    const url = `${this.config.url}/remote.php/dav/versions/${userSegment}${path}`;
    return this.fetchWithRetry(
      url,
      { method, headers: { Authorization: this.authHeader, ...extraHeaders }, body },
      `Versions ${method} ${path}`,
      true,
    );
  }
}

/**
 * Build a WebDAV path by encoding each segment. Empty segments are dropped,
 * and any embedded `/` inside a segment is split and encoded per-piece.
 *
 * Example: `encodeWebDavPath('.Collectives/Wiki', 'Vibe Coding', 'Readme.md')`
 *          → `/.Collectives/Wiki/Vibe%20Coding/Readme.md`
 */
export function encodeWebDavPath(...segments: string[]): string {
  const parts = segments
    .filter((s) => s != null && s !== '')
    .flatMap((s) => s.split('/'))
    .filter((s) => s !== '')
    .map(encodeURIComponent);
  return '/' + parts.join('/');
}
