import type { Config } from './config.js';

/** Path prefix for Collectives v1 endpoints, appended after `/ocs/v2.php`. */
export const COLLECTIVES_API = '/apps/collectives/api/v1.0';

/** A failed HTTP response (non-2xx status). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    body: string,
  ) {
    const snippet = body.length > 500 ? `${body.slice(0, 500)}…` : body;
    super(`HTTP ${status} ${statusText}${snippet ? `: ${snippet}` : ''}`);
    this.name = 'HttpError';
  }
}

/** A 2xx response that an OCS endpoint reports as a failure in its envelope. */
export class OcsError extends Error {
  constructor(
    public readonly statuscode: number,
    message: string,
  ) {
    super(`OCS ${statuscode}: ${message}`);
    this.name = 'OcsError';
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
   * Returns the unwrapped `ocs.data` payload.
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

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
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

  /**
   * Call a WebDAV endpoint under the user's Files area. `path` is appended to
   * `/remote.php/dav/files/{user}` and must start with `/`. Path segments should
   * be passed already URL-encoded (use {@link encodeWebDavPath}).
   * Returns the raw `Response` for callers that need headers or streaming bodies.
   */
  async webdav(
    method: string,
    path: string,
    body?: BodyInit,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const userSegment = encodeURIComponent(this.config.user);
    const url = `${this.config.url}/remote.php/dav/files/${userSegment}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        ...extraHeaders,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(res.status, res.statusText, text);
    }
    return res;
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
