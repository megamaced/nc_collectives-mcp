import type { Config } from './config.js';

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
   * Call an OCS API endpoint relative to the Collectives app
   * (e.g. `/collectives` resolves to `/ocs/v2.php/apps/collectives/api/v1.0/collectives`).
   * Returns the unwrapped `ocs.data` payload.
   */
  async ocs<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.config.url}/ocs/v2.php/apps/collectives/api/v1.0${path}`;
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
   * Call a WebDAV endpoint under the user's Files area
   * (path is appended to `/remote.php/dav/files/{user}` and is expected to start with `/`).
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
