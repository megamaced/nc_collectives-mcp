export interface Config {
  /** Nextcloud base URL with no trailing slash, e.g. `https://cloud.example.com`. */
  url: string;
  /** Nextcloud username. */
  user: string;
  /** Nextcloud app-password (never the user's real account password). */
  password: string;
}

const REQUIRED = ['NEXTCLOUD_URL', 'NEXTCLOUD_USER', 'NEXTCLOUD_APP_PASSWORD'] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Generate an app-password in Nextcloud (Settings → Security → Devices & sessions) ' +
        'and pass NEXTCLOUD_URL, NEXTCLOUD_USER, NEXTCLOUD_APP_PASSWORD to the MCP server.',
    );
  }

  const rawUrl = env.NEXTCLOUD_URL!.trim();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`NEXTCLOUD_URL is not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`NEXTCLOUD_URL must use http or https, got ${url.protocol}`);
  }

  return {
    url: rawUrl.replace(/\/+$/, ''),
    user: env.NEXTCLOUD_USER!.trim(),
    password: env.NEXTCLOUD_APP_PASSWORD!,
  };
}
