import { COLLECTIVES_API, encodeWebDavPath, type NextcloudClient } from './http.js';
import type { Collective, Page } from './types.js';

// -----------------------------------------------------------------------------
// Collectives
// -----------------------------------------------------------------------------

export async function listCollectives(client: NextcloudClient): Promise<Collective[]> {
  const data = await client.ocs<{ collectives: Collective[] }>(
    'GET',
    `${COLLECTIVES_API}/collectives`,
  );
  return data.collectives;
}

export interface CreateCollectiveInput {
  name: string;
  emoji?: string;
}

export async function createCollective(
  client: NextcloudClient,
  input: CreateCollectiveInput,
): Promise<Collective> {
  const data = await client.ocs<{ collective: Collective }>(
    'POST',
    `${COLLECTIVES_API}/collectives`,
    input,
  );
  return data.collective;
}

export interface UpdateCollectiveInput {
  name?: string;
  emoji?: string;
  /** Empty string clears the emoji. */
  editPermissionLevel?: number;
  sharePermissionLevel?: number;
}

/**
 * Apply each provided field via its dedicated PUT endpoint and return the
 * refreshed Collective. Fields with no value are skipped.
 */
export async function updateCollective(
  client: NextcloudClient,
  id: number,
  patch: UpdateCollectiveInput,
): Promise<Collective> {
  const base = `${COLLECTIVES_API}/collectives/${id}`;
  if (patch.name !== undefined) {
    await client.ocs('PUT', `${base}/name`, { name: patch.name });
  }
  if (patch.emoji !== undefined) {
    await client.ocs('PUT', `${base}/emoji`, { emoji: patch.emoji });
  }
  if (patch.editPermissionLevel !== undefined) {
    await client.ocs('PUT', `${base}/editLevel`, { level: patch.editPermissionLevel });
  }
  if (patch.sharePermissionLevel !== undefined) {
    await client.ocs('PUT', `${base}/shareLevel`, { level: patch.sharePermissionLevel });
  }
  const refreshed = (await listCollectives(client)).find((c) => c.id === id);
  if (!refreshed) {
    throw new Error(`Collective ${id} not found after update`);
  }
  return refreshed;
}

export interface DeleteCollectiveInput {
  /** When true, also delete the underlying Nextcloud Team (Circle). Default true. */
  deleteTeam?: boolean;
}

/**
 * Soft-delete a Collective (moves it to the Collectives trash, recoverable in
 * the UI). When `deleteTeam` is true the underlying Team is removed as well.
 */
export async function deleteCollective(
  client: NextcloudClient,
  id: number,
  input: DeleteCollectiveInput = {},
): Promise<void> {
  const deleteTeam = input.deleteTeam ?? true;
  const query = deleteTeam ? '?circle=true' : '';
  await client.ocs('DELETE', `${COLLECTIVES_API}/collectives/${id}${query}`);
}

// -----------------------------------------------------------------------------
// Pages
// -----------------------------------------------------------------------------

export async function listPages(
  client: NextcloudClient,
  collectiveId: number,
): Promise<Page[]> {
  const data = await client.ocs<{ pages: Page[] }>(
    'GET',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages`,
  );
  return data.pages;
}

/**
 * Read the markdown content of a page. Resolves the WebDAV path from the
 * page's metadata (`collectivePath`, `filePath`, `fileName`).
 */
export async function getPage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<{ page: Page; markdown: string }> {
  const pages = await listPages(client, collectiveId);
  const page = pages.find((p) => p.id === pageId);
  if (!page) {
    throw new Error(`Page ${pageId} not found in collective ${collectiveId}`);
  }
  const path = encodeWebDavPath(page.collectivePath, page.filePath, page.fileName);
  const res = await client.webdav('GET', path);
  const markdown = await res.text();
  return { page, markdown };
}

// -----------------------------------------------------------------------------
// Search
// -----------------------------------------------------------------------------

/**
 * Provider id for Nextcloud unified search. The Collectives app registers
 * `collectives-pages`. This is verified empirically; if the search call
 * returns "provider not found" on a particular Nextcloud version, listing
 * `/ocs/v2.php/search/providers` will reveal the active id.
 */
export const COLLECTIVES_SEARCH_PROVIDER = 'collectives-pages';

export interface SearchResult {
  /** Matching page title. */
  title: string;
  /** Highlight excerpt; varies by Nextcloud version. */
  subline?: string;
  /** Path to the page in the Collectives UI. */
  resourceUrl?: string;
  icon?: string;
  rounded?: boolean;
  attributes?: Record<string, string>;
}

export async function searchPages(
  client: NextcloudClient,
  query: string,
  limit = 25,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ term: query, limit: String(limit) });
  const data = await client.ocs<{ entries: SearchResult[] }>(
    'GET',
    `/search/providers/${COLLECTIVES_SEARCH_PROVIDER}/search?${params.toString()}`,
  );
  return data.entries;
}
