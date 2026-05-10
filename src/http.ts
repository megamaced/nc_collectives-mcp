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

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a Retry-After header. Returns delay in milliseconds, or null if
 * the header is absent / unparseable.
 */
function parseRetryAfter(res: Response): number | null {
  const header = res.headers.get('Retry-After');
  if (!header) return null;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

// -----------------------------------------------------------------------------
// Error classes
// -----------------------------------------------------------------------------

/** A failed HTTP response (non-2xx status). */
export class HttpError extends Error {
  /** Human-readable suggestion for how the caller might fix the problem. */
  public readonly hint: string;

  constructor(
    public readonly status: number,
    public readonly statusText: string,
    body: string,
  ) {
    const snippet = body.length > 500 ? `${body.slice(0, 500)}…` : body;
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
    case 405: return 'Method not allowed — this OCS endpoint may not support this operation.';
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

  constructor(private readonly config: Config) {
    const token = Buffer.from(`${config.user}:${config.password}`, 'utf8').toString('base64');
    this.authHeader = `Basic ${token}`;
  }

  /**
   * Call any OCS endpoint. `path` is appended after `/ocs/v2.php` and must start with `/`
   * (e.g. `/apps/collectives/api/v1.0/collectives` or `/search/providers/foo/search`).
   * Returns the unwrapped `ocs.data` payload. Retries on 429 / 5xx.
   */
  async ocs<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.config.url}/ocs/v2.php${path}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
      'OCS-APIRequest': 'true',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        debug(`Retry ${attempt}/${MAX_RETRIES} for ${method} ${path} after ${delay}ms`);
        await sleep(delay);
      }

      debug(`${method} ${path}`);
      const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();

      if (!res.ok) {
        if (isRetryable(res.status) && attempt < MAX_RETRIES) {
          const retryDelay = parseRetryAfter(res);
          if (retryDelay !== null) await sleep(retryDelay);
          lastError = new HttpError(res.status, res.statusText, text);
          continue;
        }
        throw new HttpError(res.status, res.statusText, text);
      }

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
    throw lastError ?? new Error('Unexpected retry exhaustion');
  }

  /**
   * Call a WebDAV endpoint under the user's Files area. `path` is appended to
   * `/remote.php/dav/files/{user}` and must start with `/`. Path segments should
   * be passed already URL-encoded (use {@link encodeWebDavPath}).
   * Returns the raw `Response` for callers that need headers or streaming bodies.
   * Retries on 429 / 5xx.
   */
  async webdav(
    method: string,
    path: string,
    body?: string | Uint8Array,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const url = this.webdavUrl(path);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        debug(`Retry ${attempt}/${MAX_RETRIES} for WebDAV ${method} ${path} after ${delay}ms`);
        await sleep(delay);
      }

      debug(`WebDAV ${method} ${path}`);
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          ...extraHeaders,
        },
        body,
      });
      // 207 Multi-Status (PROPFIND) and 204 No Content are also success.
      if (!res.ok && res.status !== 207) {
        if (isRetryable(res.status) && attempt < MAX_RETRIES) {
          const retryDelay = parseRetryAfter(res);
          if (retryDelay !== null) await sleep(retryDelay);
          const text = await res.text().catch(() => '');
          lastError = new HttpError(res.status, res.statusText, text);
          continue;
        }
        const text = await res.text().catch(() => '');
        throw new HttpError(res.status, res.statusText, text);
      }
      return res;
    }
    throw lastError ?? new Error('Unexpected retry exhaustion');
  }

  /**
   * Absolute URL for a WebDAV path under the user's Files area. Needed for
   * the `Destination` header of MOVE / COPY requests, which must be a full URL.
   */
  webdavUrl(path: string): string {
    const userSegment = encodeURIComponent(this.config.user);
    return `${this.config.url}/remote.php/dav/files/${userSegment}${path}`;
  }

  /**
   * Call a WebDAV endpoint under the user's versions area. `path` is appended to
   * `/remote.php/dav/versions/{user}` and must start with `/`.
   * Returns the raw `Response`. Retries on 429 / 5xx.
   */
  async webdavVersions(
    method: string,
    path: string,
    body?: string | Uint8Array,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const userSegment = encodeURIComponent(this.config.user);
    const url = `${this.config.url}/remote.php/dav/versions/${userSegment}${path}`;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        debug(`Retry ${attempt}/${MAX_RETRIES} for Versions ${method} ${path} after ${delay}ms`);
        await sleep(delay);
      }

      debug(`Versions ${method} ${path}`);
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          ...extraHeaders,
        },
        body,
      });
      if (!res.ok && res.status !== 207) {
        if (isRetryable(res.status) && attempt < MAX_RETRIES) {
          const retryDelay = parseRetryAfter(res);
          if (retryDelay !== null) await sleep(retryDelay);
          const text = await res.text().catch(() => '');
          lastError = new HttpError(res.status, res.statusText, text);
          continue;
        }
        const text = await res.text().catch(() => '');
        throw new HttpError(res.status, res.statusText, text);
      }
      return res;
    }
    throw lastError ?? new Error('Unexpected retry exhaustion');
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
