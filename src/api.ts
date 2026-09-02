import { COLLECTIVES_API, encodeWebDavPath, HttpError, type NextcloudClient } from './http.js';
import type {
  Collective,
  CollectiveShare,
  CollectiveTag,
  Page,
  PageAttachment,
  PageVersion,
} from './types.js';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Fetch a single page's metadata via the dedicated OCS endpoint. */
async function getPageMeta(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<Page> {
  const data = await client.ocs<{ page: Page }>(
    'GET',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}`,
  );
  return data.page;
}

/** Full WebDAV path to a page's content file. */
function pageFilePath(page: Page): string {
  return encodeWebDavPath(page.collectivePath, page.filePath, page.fileName);
}

/** WebDAV path to the `.attachments.{pageId}/` directory for a page. */
function attachmentsDirPath(page: Page): string {
  return encodeWebDavPath(page.collectivePath, page.filePath, `.attachments.${page.id}`);
}

// -----------------------------------------------------------------------------
// Filename sanitisation (attachment filenames only — page titles are the OCS
// API's responsibility; it derives the filename server-side)
// -----------------------------------------------------------------------------

/** Sanitize an attachment filename — strip path separators, control chars. */
function sanitizeAttachmentName(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`Invalid attachment filename: "${name}"`);
  }
  if (Buffer.byteLength(cleaned, 'utf8') > 255) {
    throw new Error(`Attachment filename too long: "${cleaned}"`);
  }
  return cleaned;
}

/**
 * MIME types whose payload is text, so `content` is taken as literal UTF-8.
 * Anything else defaults to base64. The `+json` / `+xml` structured suffixes
 * and `image/svg+xml` matter here: they are textual despite not being `text/*`,
 * and guessing binary for them silently truncated the upload to whatever the
 * base64 decoder made of the raw characters.
 */
export function isTextualMimeType(contentType: string): boolean {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type.startsWith('text/')) return true;
  if (/\+(json|xml)$/.test(type)) return true;
  return [
    'application/json',
    'application/xml',
    'application/javascript',
    'application/ecmascript',
    'application/x-yaml',
    'application/yaml',
    'application/sql',
    'application/graphql',
  ].includes(type);
}

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
  emoji?: string;
  editPermissionLevel?: number;
  sharePermissionLevel?: number;
}

/**
 * Update a Collective. Emoji is set via `PUT /collectives/{id}`, while
 * editLevel and shareLevel have their own dedicated sub-path endpoints.
 * There is no name-change endpoint in the API.
 */
export async function updateCollective(
  client: NextcloudClient,
  id: number,
  patch: UpdateCollectiveInput,
): Promise<Collective> {
  const base = `${COLLECTIVES_API}/collectives/${id}`;
  if (patch.emoji !== undefined) {
    await client.ocs('PUT', base, { emoji: patch.emoji });
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

/** Soft-delete a Collective (moves it to the Collectives trash, recoverable). */
export async function deleteCollective(
  client: NextcloudClient,
  id: number,
): Promise<void> {
  await client.ocs('DELETE', `${COLLECTIVES_API}/collectives/${id}`);
}

// -----------------------------------------------------------------------------
// Collective trash
// -----------------------------------------------------------------------------

/** List Collectives that have been soft-deleted. */
export async function listTrashedCollectives(client: NextcloudClient): Promise<Collective[]> {
  const data = await client.ocs<{ collectives: Collective[] }>(
    'GET',
    `${COLLECTIVES_API}/collectives/trash`,
  );
  return data.collectives;
}

/** Restore a soft-deleted Collective from the trash. */
export async function restoreTrashedCollective(
  client: NextcloudClient,
  id: number,
): Promise<Collective> {
  const data = await client.ocs<{ collective: Collective }>(
    'PATCH',
    `${COLLECTIVES_API}/collectives/trash/${id}`,
  );
  return data.collective;
}

/**
 * Permanently delete a Collective from the trash. Irreversible.
 * When `deleteTeam` is true the underlying Nextcloud Team is removed as well.
 */
export async function permanentlyDeleteCollective(
  client: NextcloudClient,
  id: number,
  deleteTeam = false,
): Promise<void> {
  const query = deleteTeam ? '?circle=true' : '';
  await client.ocs('DELETE', `${COLLECTIVES_API}/collectives/trash/${id}${query}`);
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
 * Read the markdown content of a page. Uses the dedicated single-page OCS
 * endpoint for metadata, then fetches the body via WebDAV.
 */
export async function getPage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<{ page: Page; markdown: string }> {
  const page = await getPageMeta(client, collectiveId, pageId);
  const path = pageFilePath(page);
  const res = await client.webdav('GET', path);
  const markdown = await res.text();
  return { page, markdown };
}

// -----------------------------------------------------------------------------
// Search
// -----------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  subline?: string;
  resourceUrl?: string;
  icon?: string;
  rounded?: boolean;
  attributes?: Record<string, string>;
}

/**
 * Full-text search across all Collectives via the Nextcloud unified search
 * provider `collectives-pages`.
 */
export async function searchPages(
  client: NextcloudClient,
  query: string,
  limit = 25,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ term: query, limit: String(limit) });
  const data = await client.ocs<{ entries: SearchResult[] }>(
    'GET',
    `/search/providers/collectives-pages/search?${params.toString()}`,
  );
  return data.entries;
}

/**
 * Search for pages by content within a specific Collective.
 * Per the OpenAPI spec: `GET .../collectives/{id}/search?searchString=`.
 */
export async function searchPagesInCollective(
  client: NextcloudClient,
  collectiveId: number,
  query: string,
): Promise<Page[]> {
  const params = new URLSearchParams({ searchString: query });
  const data = await client.ocs<{ pages: Page[] }>(
    'GET',
    `${COLLECTIVES_API}/collectives/${collectiveId}/search?${params.toString()}`,
  );
  return data.pages;
}

// -----------------------------------------------------------------------------
// Page writes — using OCS endpoints
// -----------------------------------------------------------------------------

export interface CreatePageInput {
  collectiveId: number;
  parentPageId: number;
  title: string;
  /** Markdown body. Empty string allowed. */
  body?: string;
  /** Optional emoji to set after creation. */
  emoji?: string;
  /** Template page id to copy initial content from. */
  templateId?: number;
}

/**
 * Create a new page under a parent via the OCS API. The server handles folder
 * promotion and naming automatically. If `body` is provided, it is written
 * via WebDAV after creation.
 *
 * Per the OpenAPI spec: `POST .../pages/{parentId}` with `{title, templateId?}` in body.
 */
export async function createPage(
  client: NextcloudClient,
  input: CreatePageInput,
): Promise<Page> {
  const ocsBody: Record<string, unknown> = { title: input.title };
  if (input.templateId !== undefined) ocsBody.templateId = input.templateId;

  const data = await client.ocs<{ page: Page }>(
    'POST',
    `${COLLECTIVES_API}/collectives/${input.collectiveId}/pages/${input.parentPageId}`,
    ocsBody,
  );
  let page = data.page;

  // `!== undefined`, not truthiness: an explicit empty body is a request to
  // create an empty page — and to clear a template's content when templateId
  // was also supplied.
  if (input.body !== undefined) {
    const path = pageFilePath(page);
    await client.webdav('PUT', path, input.body);
    page = await getPageMeta(client, input.collectiveId, page.id);
  }

  if (input.emoji) {
    page = await setPageEmoji(client, input.collectiveId, page.id, input.emoji);
  }

  return page;
}

export type UpdateMode = 'replace' | 'append' | 'prepend';

/** How many times an append/prepend re-reads and reapplies after a lost race. */
const MAX_APPEND_ATTEMPTS = 3;

/** Splice `body` onto `existing` on the side the mode asks for. */
function spliceBody(existing: string, body: string, mode: 'append' | 'prepend'): string {
  if (mode === 'append') {
    const sep = existing.endsWith('\n') ? '' : '\n';
    return `${existing}${sep}${body}`;
  }
  const sep = body.endsWith('\n') ? '' : '\n';
  return `${body}${sep}${existing}`;
}

/**
 * Overwrite, append to, or prepend to a page's markdown body via WebDAV.
 *
 * `replace` is an unconditional PUT — the caller supplied the whole document.
 * `append`/`prepend` are read-modify-write, so they capture the ETag from the
 * GET and send it as `If-Match`. If someone else writes in between, the server
 * answers 412 and the operation is retried against the new content rather than
 * overwriting the other edit.
 */
export async function updatePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  body: string,
  mode: UpdateMode = 'replace',
): Promise<Page> {
  const page = await getPageMeta(client, collectiveId, pageId);
  await writePageFile(client, page, body, mode, `Page ${pageId}`);
  return getPageMeta(client, collectiveId, pageId);
}

/**
 * Write a page's markdown file, shared by pages and templates — a template is
 * a page, so it gets the same concurrency protection.
 *
 * `replace` is an unconditional PUT: the caller supplied the whole document.
 * `append`/`prepend` are read-modify-write, so they capture the ETag from the
 * GET and send it as `If-Match`, retrying against fresh content on 412 rather
 * than overwriting someone else's edit.
 */
async function writePageFile(
  client: NextcloudClient,
  page: Page,
  body: string,
  mode: UpdateMode,
  label: string,
): Promise<void> {
  const path = pageFilePath(page);

  if (mode === 'replace') {
    await client.webdav('PUT', path, body);
    return;
  }

  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    const res = await client.webdav('GET', path);
    const etag = res.headers.get('ETag');
    const existing = await res.text();
    const newBody = spliceBody(existing, body, mode);

    try {
      await client.webdav('PUT', path, newBody, etag ? { 'If-Match': etag } : {});
      return;
    } catch (err) {
      // 412 means the file changed after our read. Re-read and reapply.
      if (err instanceof HttpError && err.status === 412 && attempt < MAX_APPEND_ATTEMPTS - 1) {
        continue;
      }
      if (err instanceof HttpError && err.status === 412) {
        throw new Error(
          `${label} was modified concurrently ${MAX_APPEND_ATTEMPTS} times while trying to ` +
            `${mode} to it. Nothing was written — retry, or read it and use mode "replace".`,
        );
      }
      throw err;
    }
  }
  /* c8 ignore next */
  throw new Error('Unexpected append/prepend retry exhaustion');
}

/**
 * Trash a page (recoverable from Collectives page trash). The Landing page
 * (parentId 0) cannot be deleted — delete the Collective itself instead.
 * A 404 is treated as idempotent success.
 *
 * Per the OpenAPI spec: `DELETE .../pages/{id}` — summary "Trash a page".
 */
export async function deletePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<void> {
  let page: Page;
  try {
    page = await getPageMeta(client, collectiveId, pageId);
  } catch (err) {
    // Already gone — the caller's desired state is satisfied.
    if (err instanceof HttpError && err.status === 404) return;
    throw err;
  }
  if (page.parentId === 0) {
    throw new Error('Cannot delete the Landing page; delete the Collective instead.');
  }

  try {
    await client.ocs(
      'DELETE',
      `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}`,
    );
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return;
    throw err;
  }
}

/**
 * Rename a page via the OCS page-update endpoint.
 * Per the OpenAPI spec: `PUT .../pages/{id}` with `{title}` in body.
 */
export async function renamePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  newTitle: string,
): Promise<Page> {
  const data = await client.ocs<{ page: Page }>(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}`,
    { title: newTitle },
  );
  return data.page;
}

/**
 * Move a page under a different parent via the OCS page-update endpoint.
 * Per the OpenAPI spec: `PUT .../pages/{id}` with `{parentId, index?}` in body.
 *
 * `index` is the position among the new parent's children. Omitted means the
 * server's default (0, i.e. first).
 */
export async function movePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  newParentPageId: number,
  index?: number,
): Promise<Page> {
  const body: Record<string, unknown> = { parentId: newParentPageId };
  if (index !== undefined) body.index = index;
  const data = await client.ocs<{ page: Page }>(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}`,
    body,
  );
  return data.page;
}

/**
 * Toggle a page's full-width layout.
 * Per the OpenAPI spec: `PUT .../pages/{id}/fullWidth` with `{fullWidth}`.
 */
export async function setPageFullWidth(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  fullWidth: boolean,
): Promise<Page> {
  const data = await client.ocs<{ page: Page }>(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}/fullWidth`,
    { fullWidth },
  );
  return data.page;
}

/**
 * Set the explicit ordering of a page's immediate children.
 *
 * The ids are validated against the page's actual children first: the API
 * takes a JSON-stringified array and silently accepts nonsense, so a typo
 * would otherwise corrupt the stored order with no error. Pass an empty array
 * to clear the manual order and fall back to the Collective's sort.
 */
export async function setSubpageOrder(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  subpageOrder: number[],
): Promise<Page> {
  const duplicates = subpageOrder.filter((id, i) => subpageOrder.indexOf(id) !== i);
  if (duplicates.length > 0) {
    throw new Error(`subpageOrder contains duplicate page ids: ${[...new Set(duplicates)].join(', ')}`);
  }

  const children = (await listPages(client, collectiveId)).filter((p) => p.parentId === pageId);
  const childIds = new Set(children.map((c) => c.id));
  const unknown = subpageOrder.filter((id) => !childIds.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `subpageOrder references pages that are not children of page ${pageId}: ${unknown.join(', ')}. ` +
        `Children are: ${[...childIds].join(', ') || '(none)'}.`,
    );
  }

  const data = await client.ocs<{ page: Page }>(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}/subpageOrder`,
    { subpageOrder: JSON.stringify(subpageOrder) },
  );
  return data.page;
}

/**
 * Bump a page's modification timestamp and last-editor without changing its
 * content. Per the OpenAPI spec this endpoint is a `GET`, despite mutating.
 */
export async function touchPage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<Page> {
  const data = await client.ocs<{ page: Page }>(
    'GET',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}/touch`,
  );
  return data.page;
}

/**
 * Set a single emoji icon on a page. Pass an empty string to clear.
 * Per the OpenAPI spec: `PUT .../pages/{id}/emoji`.
 */
export async function setPageEmoji(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  emoji: string,
): Promise<Page> {
  const data = await client.ocs<{ page: Page }>(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}/emoji`,
    { emoji },
  );
  return data.page;
}

/**
 * Duplicate a page via the OCS page-update endpoint. Supports both leaf and
 * folder pages. If `newTitle` is provided, the copy gets that title.
 * Per the OpenAPI spec: `PUT .../pages/{id}` with `{copy: true}` in body.
 */
export async function copyPage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  newTitle?: string,
  index?: number,
): Promise<Page> {
  const body: Record<string, unknown> = { copy: true };
  if (newTitle) body.title = newTitle;
  if (index !== undefined) body.index = index;
  // Marked non-idempotent explicitly: the method is PUT, but each call creates
  // another copy, so a 5xx must not be replayed.
  const data = await client.ocs<{ page: Page }>(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}`,
    body,
    false,
  );
  return data.page;
}

export interface MoveToCollectiveOptions {
  /** Target parent page in the destination Collective. Omit for its root. */
  parentId?: number;
  /** Position among the target parent's children. */
  index?: number;
  /** Copy instead of moving. */
  copy?: boolean;
}

/**
 * Move or copy a page into a different Collective.
 * Per the OpenAPI spec: `PUT .../pages/{id}/to/{newCollectiveId}` with
 * `{parentId?, index?, copy?}`.
 *
 * The endpoint returns no page data, and moving a page can change its
 * Nextcloud file id, so the result is located by listing the destination
 * Collective rather than by re-fetching the original id — which may now 404.
 */
export async function movePageToCollective(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  newCollectiveId: number,
  options: MoveToCollectiveOptions = {},
): Promise<Page> {
  if (collectiveId === newCollectiveId) {
    throw new Error(
      `Source and destination Collective are both ${collectiveId}. ` +
        'Use move_page or copy_page to reorganise within one Collective.',
    );
  }

  // Fail early with a clear message rather than a bare 404 from the endpoint.
  const accessible = await listCollectives(client);
  for (const id of [collectiveId, newCollectiveId]) {
    if (!accessible.some((c) => c.id === id)) {
      throw new Error(`Collective ${id} is not accessible to this user.`);
    }
  }
  const source = await getPageMeta(client, collectiveId, pageId);
  if (source.parentId === 0 && !options.copy) {
    throw new Error('Cannot move the Landing page out of its Collective; copy it instead.');
  }

  const before = new Set((await listPages(client, newCollectiveId)).map((p) => p.id));

  const body: Record<string, unknown> = {};
  if (options.parentId !== undefined) body.parentId = options.parentId;
  if (options.index !== undefined) body.index = options.index;
  if (options.copy !== undefined) body.copy = options.copy;

  // Not idempotent when copying: each call would create another page.
  await client.ocs(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}/to/${newCollectiveId}`,
    body,
    options.copy ? false : undefined,
  );

  const after = await listPages(client, newCollectiveId);
  const arrived = after.find((p) => !before.has(p.id) && p.title === source.title)
    ?? after.find((p) => !before.has(p.id));
  if (!arrived) {
    throw new Error(
      `Page ${pageId} was ${options.copy ? 'copied' : 'moved'} to Collective ${newCollectiveId}, ` +
        'but the resulting page could not be located. List its pages to confirm.',
    );
  }
  return arrived;
}

// -----------------------------------------------------------------------------
// Favorites
// -----------------------------------------------------------------------------

/** Mark a page as a favorite for the current user. */
export async function favoritePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<void> {
  const collective = (await listCollectives(client)).find((c) => c.id === collectiveId);
  if (!collective) throw new Error(`Collective ${collectiveId} not found`);
  const current = (collective.userFavoritePages ?? []).slice();
  if (current.includes(pageId)) return;
  await client.ocs(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/userSettings/favoritePages`,
    { favoritePages: JSON.stringify([...current, pageId]) },
  );
}

/** Remove a page from the current user's favorites. */
export async function unfavoritePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<void> {
  const collective = (await listCollectives(client)).find((c) => c.id === collectiveId);
  if (!collective) throw new Error(`Collective ${collectiveId} not found`);
  const current = (collective.userFavoritePages ?? []).slice();
  if (!current.includes(pageId)) return;
  await client.ocs(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/userSettings/favoritePages`,
    { favoritePages: JSON.stringify(current.filter((id) => id !== pageId)) },
  );
}

// -----------------------------------------------------------------------------
// Tags
// -----------------------------------------------------------------------------

/** List all tags defined for a Collective. */
export async function listTags(
  client: NextcloudClient,
  collectiveId: number,
): Promise<CollectiveTag[]> {
  const data = await client.ocs<{ tags: CollectiveTag[] }>(
    'GET',
    `${COLLECTIVES_API}/collectives/${collectiveId}/tags`,
  );
  return data.tags ?? [];
}

/**
 * Normalise a hex colour to the bare six digits the DB column (`varchar(6)`)
 * accepts. Anything else is rejected here rather than becoming a database
 * overflow or a silently wrong colour on the server.
 */
export function normalizeColor(color: string): string {
  const cleaned = color.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    throw new Error(
      `Invalid tag color "${color}": expected exactly six hexadecimal digits, ` +
        'with an optional leading "#" (e.g. "#2d7d46" or "2d7d46").',
    );
  }
  return cleaned;
}

/** Create a new tag in a Collective. */
export async function createTag(
  client: NextcloudClient,
  collectiveId: number,
  name: string,
  color: string,
): Promise<CollectiveTag> {
  const data = await client.ocs<{ tag: CollectiveTag }>(
    'POST',
    `${COLLECTIVES_API}/collectives/${collectiveId}/tags`,
    { name, color: normalizeColor(color) },
  );
  return data.tag;
}

/** Update a tag's name and color. */
export async function updateTag(
  client: NextcloudClient,
  collectiveId: number,
  tagId: number,
  name: string,
  color: string,
): Promise<CollectiveTag> {
  const data = await client.ocs<{ tag: CollectiveTag }>(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/tags/${tagId}`,
    { name, color: normalizeColor(color) },
  );
  return data.tag;
}

/** Delete a tag from a Collective. */
export async function deleteTag(
  client: NextcloudClient,
  collectiveId: number,
  tagId: number,
): Promise<void> {
  await client.ocs(
    'DELETE',
    `${COLLECTIVES_API}/collectives/${collectiveId}/tags/${tagId}`,
  );
}

/**
 * Add a single tag to a page.
 * Per the OpenAPI spec: `PUT .../pages/{id}/tags/{tagId}`.
 */
export async function addPageTag(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  tagId: number,
): Promise<void> {
  await client.ocs(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}/tags/${tagId}`,
  );
}

/** Remove a single tag from a page. */
export async function removePageTag(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  tagId: number,
): Promise<void> {
  await client.ocs(
    'DELETE',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}/tags/${tagId}`,
  );
}

/**
 * Replace the tags on a page with the given set of tag ids. Implemented as
 * a diff against the page's current tags using the per-tag POST/DELETE
 * endpoints.
 */
export async function setPageTags(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  tagIds: number[],
): Promise<Page> {
  const page = await getPageMeta(client, collectiveId, pageId);
  // `page.tags` is already the list of tag ids — diff directly. The previous
  // implementation looked each entry up in a name→id map (treating tags as
  // names) and so always saw an empty current set, causing tag removals to
  // be silently dropped.
  const currentTagIds = new Set(page.tags ?? []);
  const targetTagIds = new Set(tagIds);

  for (const id of targetTagIds) {
    if (!currentTagIds.has(id)) await addPageTag(client, collectiveId, pageId, id);
  }
  for (const id of currentTagIds) {
    if (!targetTagIds.has(id)) await removePageTag(client, collectiveId, pageId, id);
  }

  return getPageMeta(client, collectiveId, pageId);
}

// -----------------------------------------------------------------------------
// Trash
// -----------------------------------------------------------------------------

/** List trashed pages for a Collective. */
export async function listTrashedPages(
  client: NextcloudClient,
  collectiveId: number,
): Promise<Page[]> {
  const data = await client.ocs<{ pages: Page[] }>(
    'GET',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/trash`,
  );
  return data.pages;
}

/**
 * Restore a page from the Collective trash.
 * Per the OpenAPI spec: `PATCH .../pages/trash/{id}`.
 */
export async function restorePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<Page> {
  const data = await client.ocs<{ page: Page }>(
    'PATCH',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/trash/${pageId}`,
  );
  return data.page;
}

/**
 * Permanently delete a trashed page. Irreversible — the page content cannot
 * be recovered after this call.
 */
export async function purgePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<void> {
  await client.ocs(
    'DELETE',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/trash/${pageId}`,
  );
}

// -----------------------------------------------------------------------------
// Page versions (WebDAV)
// -----------------------------------------------------------------------------

/**
 * List available versions for a page. Uses Nextcloud's WebDAV versions API.
 * The page `id` is the Nextcloud file id in Collectives.
 */
export async function listPageVersions(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<PageVersion[]> {
  await getPageMeta(client, collectiveId, pageId);
  const res = await client.webdavVersions('PROPFIND', `/versions/${pageId}`, undefined, {
    Depth: '1',
  });
  const xml = await res.text();
  return parseVersionsXml(xml);
}

/**
 * A Nextcloud version id is the version's storage basename — digits, and on
 * some backends a suffix of word characters. Notably it is never `.` or `..`,
 * which `encodeURIComponent` passes through unchanged.
 */
const VERSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Restore a specific version of a page by copying it back to the live path.
 *
 * The `versionId` is checked against the page's real version list before it is
 * used to build a path. URI-encoding alone is not path-safety: `..` survives
 * `encodeURIComponent`, and URL normalisation would then point the COPY source
 * at the versions collection instead of the chosen version.
 */
export async function restorePageVersion(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  versionId: string,
): Promise<Page> {
  if (versionId === '.' || versionId === '..' || !VERSION_ID_PATTERN.test(versionId)) {
    throw new Error(
      `Invalid versionId "${versionId}". Use a versionId returned by list_page_versions.`,
    );
  }

  const available = await listPageVersions(client, collectiveId, pageId);
  if (!available.some((v) => v.versionId === versionId)) {
    throw new Error(
      `Version "${versionId}" does not exist for page ${pageId}. ` +
        `Available versions: ${available.map((v) => v.versionId).join(', ') || '(none)'}.`,
    );
  }

  const page = await getPageMeta(client, collectiveId, pageId);
  const livePath = pageFilePath(page);
  const liveUrl = client.webdavUrl(livePath);

  await client.webdavVersions(
    'COPY',
    `/versions/${pageId}/${encodeURIComponent(versionId)}`,
    undefined,
    { Destination: liveUrl, Overwrite: 'T' },
  );

  return getPageMeta(client, collectiveId, pageId);
}

/** Parse a PROPFIND multistatus XML response for file versions. */
function parseVersionsXml(xml: string): PageVersion[] {
  const versions: PageVersion[] = [];
  const responseRegex = /<d:response>([\s\S]*?)<\/d:response>/g;
  let match: RegExpExecArray | null;
  let isFirst = true;
  while ((match = responseRegex.exec(xml)) !== null) {
    if (isFirst) {
      isFirst = false;
      continue;
    }
    const block = match[1]!;

    const hrefMatch = /<d:href>([^<]+)<\/d:href>/.exec(block);
    if (!hrefMatch?.[1]) continue;
    const href = decodeURIComponent(hrefMatch[1]);
    const versionId = href.split('/').filter(Boolean).pop() ?? '';
    if (!versionId) continue;

    const sizeMatch = /<d:getcontentlength>(\d+)<\/d:getcontentlength>/.exec(block);
    const size = sizeMatch?.[1] ? parseInt(sizeMatch[1], 10) : 0;

    const modMatch = /<d:getlastmodified>([^<]+)<\/d:getlastmodified>/.exec(block);
    const lastModified = modMatch?.[1] ?? '';

    versions.push({ versionId, size, lastModified });
  }
  return versions;
}

// -----------------------------------------------------------------------------
// Recent pages
// -----------------------------------------------------------------------------

/**
 * List recently-modified pages for a Collective, sorted by timestamp descending.
 * Fetches the full page list and sorts client-side.
 */
export async function listRecentPages(
  client: NextcloudClient,
  collectiveId: number,
  limit = 25,
): Promise<Page[]> {
  const pages = await listPages(client, collectiveId);
  return pages.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

// -----------------------------------------------------------------------------
// Backlinks
// -----------------------------------------------------------------------------

/**
 * Get backlinks for a page — returns other pages whose `linkedPageIds`
 * includes the target.
 */
export async function getBacklinks(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<Page[]> {
  const pages = await listPages(client, collectiveId);
  return pages.filter((p) => p.linkedPageIds.includes(pageId));
}

// -----------------------------------------------------------------------------
// Attachments — OCS for listing, WebDAV for upload/delete
// -----------------------------------------------------------------------------

/** List attachments for a page via the OCS API. */
export async function listAttachments(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<PageAttachment[]> {
  const data = await client.ocs<{ attachments: PageAttachment[] }>(
    'GET',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}/attachments`,
  );
  return data.attachments ?? [];
}

/**
 * Upload an attachment to a page via WebDAV. Creates the `.attachments.{pageId}/`
 * directory if it doesn't exist. Returns metadata from a follow-up OCS list
 * call (with a fallback if the attachment isn't indexed yet).
 */
export async function uploadAttachment(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  filename: string,
  content: Uint8Array | string,
  contentType?: string,
): Promise<PageAttachment> {
  const page = await getPageMeta(client, collectiveId, pageId);
  const cleanName = sanitizeAttachmentName(filename);
  const dirPath = attachmentsDirPath(page);

  // Ensure directory exists (405 = already exists).
  try {
    await client.webdav('MKCOL', `${dirPath}/`);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 405)) throw err;
  }

  const filePath = `${dirPath}/${encodeURIComponent(cleanName)}`;
  const headers: Record<string, string> = {};
  if (contentType) headers['Content-Type'] = contentType;

  await client.webdav('PUT', filePath, typeof content === 'string' ? content : content, headers);

  // Try to return full metadata from OCS; fall back to a constructed object.
  const attachments = await listAttachments(client, collectiveId, pageId);
  return attachments.find((a) => a.name === cleanName) ?? {
    id: 0,
    pageId,
    name: cleanName,
    filesize: typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length,
    mimetype: contentType ?? 'application/octet-stream',
    timestamp: Math.floor(Date.now() / 1000),
  };
}

/**
 * Delete an attachment from a page.
 *
 * The filename is resolved against the page's actual attachment list and the
 * deletion is issued by attachment id through OCS. Building a WebDAV path from
 * a caller-supplied name is unsafe: `encodeURIComponent` leaves `.` and `..`
 * untouched, and URL normalisation then walks the DELETE out of the
 * `.attachments.{pageId}/` directory and into the page folder or Collective root.
 */
export async function deleteAttachment(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  filename: string,
): Promise<PageAttachment> {
  const attachment = await resolveAttachment(client, collectiveId, pageId, filename);
  await client.ocs(
    'DELETE',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}/attachments/${attachment.id}`,
  );
  return attachment;
}

/**
 * Resolve an attachment by name against a page's real attachment list.
 * Every by-name operation goes through this, so a caller-supplied string is
 * matched against known data instead of being interpolated into a path.
 */
async function resolveAttachment(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  filename: string,
): Promise<PageAttachment> {
  const attachments = await listAttachments(client, collectiveId, pageId);
  const match = attachments.find((a) => a.name === filename);
  if (!match) {
    const available = attachments.map((a) => a.name);
    throw new Error(
      `No attachment named "${filename}" on page ${pageId}. ` +
        (available.length > 0
          ? `Available: ${available.join(', ')}.`
          : 'The page has no attachments.'),
    );
  }
  return match;
}

/** Upper bound on a download returned inline through the MCP transport. */
export const MAX_ATTACHMENT_DOWNLOAD_BYTES = 5 * 1024 * 1024;

export interface AttachmentContent {
  attachment: PageAttachment;
  /** How `content` is encoded. */
  encoding: 'utf8' | 'base64';
  content: string;
}

/**
 * Download an attachment's bytes via WebDAV.
 *
 * The name is resolved against the page's attachment list first, then the path
 * is rebuilt from the page metadata — the same construction `uploadAttachment`
 * uses — so no caller string reaches the path builder. Size is checked against
 * the listed metadata before the transfer, since the result is returned inline
 * to the MCP client.
 */
export async function getAttachment(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  filename: string,
  encoding?: 'utf8' | 'base64',
): Promise<AttachmentContent> {
  const page = await getPageMeta(client, collectiveId, pageId);
  const attachment = await resolveAttachment(client, collectiveId, pageId, filename);

  if (attachment.filesize > MAX_ATTACHMENT_DOWNLOAD_BYTES) {
    throw new Error(
      `Attachment "${filename}" is ${attachment.filesize} bytes, over the ` +
        `${MAX_ATTACHMENT_DOWNLOAD_BYTES}-byte inline download limit. ` +
        'Retrieve it directly from Nextcloud instead.',
    );
  }

  const dirPath = attachmentsDirPath(page);
  const filePath = `${dirPath}/${encodeURIComponent(attachment.name)}`;
  const res = await client.webdav('GET', filePath);
  const buffer = Buffer.from(await res.arrayBuffer());

  const resolved = encoding ?? (isTextualMimeType(attachment.mimetype) ? 'utf8' : 'base64');
  return {
    attachment,
    encoding: resolved,
    content: resolved === 'utf8' ? buffer.toString('utf8') : buffer.toString('base64'),
  };
}

/**
 * Rename an attachment by id via OCS.
 * Per the OpenAPI spec: `PUT .../attachments/{attachmentId}` with `{name}`.
 *
 * Note this does not rewrite references to the old name in page bodies — the
 * Collectives UI has the same behaviour.
 */
export async function renameAttachment(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  filename: string,
  newName: string,
): Promise<PageAttachment> {
  const attachment = await resolveAttachment(client, collectiveId, pageId, filename);
  const cleanName = sanitizeAttachmentName(newName);
  const data = await client.ocs<{ attachment: PageAttachment }>(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}/attachments/${attachment.id}`,
    { name: cleanName },
  );
  return data.attachment;
}

/**
 * Restore a deleted attachment from the page's attachment trash.
 * Per the OpenAPI spec: `PATCH .../attachments/trash/{attachmentId}`.
 *
 * Takes the numeric id rather than a name: a trashed attachment is by
 * definition absent from `list_attachments`, so there is nothing to resolve a
 * name against. The id comes from the `delete_attachment` result.
 */
export async function restoreAttachment(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  attachmentId: number,
): Promise<PageAttachment> {
  const data = await client.ocs<{ attachment: PageAttachment }>(
    'PATCH',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}/attachments/trash/${attachmentId}`,
  );
  return data.attachment;
}

// -----------------------------------------------------------------------------
// Public shares (#22)
// -----------------------------------------------------------------------------

/**
 * List every public share on a Collective — both the Collective-wide share and
 * any per-page shares. Distinguish them by `pageId`: 0 is Collective-wide.
 *
 * Per the OpenAPI spec this endpoint returns a bare array as `ocs.data`, not
 * an object with a `shares` key.
 */
export async function listShares(
  client: NextcloudClient,
  collectiveId: number,
): Promise<CollectiveShare[]> {
  const data = await client.ocs<CollectiveShare[]>(
    'GET',
    `${COLLECTIVES_API}/collectives/${collectiveId}/shares`,
  );
  return data ?? [];
}

/**
 * Create a public share link for a whole Collective.
 * Per the OpenAPI spec: `POST .../shares` with an optional `{password}`,
 * returning the share directly as `ocs.data`.
 */
export async function createCollectiveShare(
  client: NextcloudClient,
  collectiveId: number,
  password?: string,
): Promise<CollectiveShare> {
  return client.ocs<CollectiveShare>(
    'POST',
    `${COLLECTIVES_API}/collectives/${collectiveId}/shares`,
    password !== undefined ? { password } : {},
  );
}

/** Create a public share link for a single page. */
export async function createPageShare(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  password?: string,
): Promise<CollectiveShare> {
  return client.ocs<CollectiveShare>(
    'POST',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}/shares`,
    password !== undefined ? { password } : {},
  );
}

export interface UpdateShareInput {
  /** Whether visitors may edit through the link. Required by the API. */
  editable: boolean;
  /** Set a password, or pass an empty string to remove one. */
  password?: string;
}

/**
 * Update a Collective-wide share. `editable` is required by the endpoint, so
 * callers must state it explicitly rather than have it silently reset.
 */
export async function updateCollectiveShare(
  client: NextcloudClient,
  collectiveId: number,
  token: string,
  patch: UpdateShareInput,
): Promise<CollectiveShare> {
  const body: Record<string, unknown> = { editable: patch.editable };
  if (patch.password !== undefined) body.password = patch.password;
  return client.ocs<CollectiveShare>(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/shares/${encodeURIComponent(token)}`,
    body,
  );
}

/** Update a page share. */
export async function updatePageShare(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  token: string,
  patch: UpdateShareInput,
): Promise<CollectiveShare> {
  const body: Record<string, unknown> = { editable: patch.editable };
  if (patch.password !== undefined) body.password = patch.password;
  return client.ocs<CollectiveShare>(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}/shares/${encodeURIComponent(token)}`,
    body,
  );
}

/** Revoke a Collective-wide share link. */
export async function deleteCollectiveShare(
  client: NextcloudClient,
  collectiveId: number,
  token: string,
): Promise<void> {
  await client.ocs(
    'DELETE',
    `${COLLECTIVES_API}/collectives/${collectiveId}/shares/${encodeURIComponent(token)}`,
  );
}

/** Revoke a page share link. */
export async function deletePageShare(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  token: string,
): Promise<void> {
  await client.ocs(
    'DELETE',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}/shares/${encodeURIComponent(token)}`,
  );
}

// -----------------------------------------------------------------------------
// Collective and user display settings (#26)
// -----------------------------------------------------------------------------

/** Page edit mode for a Collective. */
export const PAGE_MODES = { view: 0, edit: 1 } as const;
export type PageModeName = keyof typeof PAGE_MODES;

/**
 * Set the Collective-wide default page mode. This affects every member, unlike
 * the userSettings endpoints below which are per-user.
 */
export async function setPageMode(
  client: NextcloudClient,
  collectiveId: number,
  mode: PageModeName,
): Promise<Collective> {
  const data = await client.ocs<{ collective: Collective }>(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pageMode`,
    { mode: PAGE_MODES[mode] },
  );
  return data.collective;
}

/** Page ordering modes for the authenticated user's own view. */
export const PAGE_ORDERS = {
  byOrder: 0,
  byTimeAsc: 1,
  byTitleAsc: 2,
  byTimeDesc: 3,
  byTitleDesc: 4,
} as const;
export type PageOrderName = keyof typeof PAGE_ORDERS;

/** Set the authenticated user's page ordering for one Collective. */
export async function setUserPageOrder(
  client: NextcloudClient,
  collectiveId: number,
  pageOrder: PageOrderName,
): Promise<void> {
  await client.ocs(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/userSettings/pageOrder`,
    { pageOrder: PAGE_ORDERS[pageOrder] },
  );
}

/** Expand or collapse the members widget on the landing page, for this user. */
export async function setUserShowMembers(
  client: NextcloudClient,
  collectiveId: number,
  showMembers: boolean,
): Promise<void> {
  await client.ocs(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/userSettings/showMembers`,
    { showMembers },
  );
}

/** Expand or collapse the recent-pages widget on the landing page, for this user. */
export async function setUserShowRecentPages(
  client: NextcloudClient,
  collectiveId: number,
  showRecentPages: boolean,
): Promise<void> {
  await client.ocs(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/userSettings/showRecentPages`,
    { showRecentPages },
  );
}

// -----------------------------------------------------------------------------
// Templates
// -----------------------------------------------------------------------------

/** List page templates defined for a Collective. */
export async function listTemplates(
  client: NextcloudClient,
  collectiveId: number,
): Promise<Page[]> {
  const data = await client.ocs<{ templates: Page[] }>(
    'GET',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/templates`,
  );
  return data.templates;
}

/**
 * Create a page template.
 * Per the OpenAPI spec: `POST .../pages/templates/{parentId}` — `parentId` is
 * required in the body as well as the path, and the official web client sends
 * both.
 */
export async function createTemplate(
  client: NextcloudClient,
  collectiveId: number,
  title: string,
  parentId: number,
): Promise<Page> {
  const data = await client.ocs<{ template: Page }>(
    'POST',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/templates/${parentId}`,
    { title, parentId },
  );
  return data.template;
}

/** Rename a page template. */
export async function updateTemplate(
  client: NextcloudClient,
  collectiveId: number,
  templateId: number,
  title: string,
): Promise<Page> {
  const data = await client.ocs<{ template: Page }>(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/templates/${templateId}`,
    { title },
  );
  return data.template;
}

/** Set or clear the emoji icon on a page template. */
export async function setTemplateEmoji(
  client: NextcloudClient,
  collectiveId: number,
  templateId: number,
  emoji: string,
): Promise<Page> {
  const data = await client.ocs<{ template: Page }>(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/templates/${templateId}/emoji`,
    { emoji },
  );
  return data.template;
}

/** Delete a page template. */
export async function deleteTemplate(
  client: NextcloudClient,
  collectiveId: number,
  templateId: number,
): Promise<void> {
  await client.ocs(
    'DELETE',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/templates/${templateId}`,
  );
}

/**
 * Resolve a template by id from the Collective's template list.
 *
 * Templates have no single-template GET endpoint, so metadata comes from the
 * list. That also confirms the id really is a template rather than an ordinary
 * page before its file path is used.
 */
async function getTemplateMeta(
  client: NextcloudClient,
  collectiveId: number,
  templateId: number,
): Promise<Page> {
  const templates = await listTemplates(client, collectiveId);
  const template = templates.find((t) => t.id === templateId);
  if (!template) {
    throw new Error(
      `No template with id ${templateId} in Collective ${collectiveId}. ` +
        `Known template ids: ${templates.map((t) => t.id).join(', ') || '(none)'}.`,
    );
  }
  return template;
}

/** Read a template's metadata and markdown body. */
export async function getTemplate(
  client: NextcloudClient,
  collectiveId: number,
  templateId: number,
): Promise<{ template: Page; markdown: string }> {
  const template = await getTemplateMeta(client, collectiveId, templateId);
  const res = await client.webdav('GET', pageFilePath(template));
  return { template, markdown: await res.text() };
}

/**
 * Overwrite, append to, or prepend to a template's markdown body.
 *
 * Templates are pages on disk, so this shares the page write path and its
 * If-Match concurrency handling.
 */
export async function updateTemplateContent(
  client: NextcloudClient,
  collectiveId: number,
  templateId: number,
  body: string,
  mode: UpdateMode = 'replace',
): Promise<Page> {
  const template = await getTemplateMeta(client, collectiveId, templateId);
  await writePageFile(client, template, body, mode, `Template ${templateId}`);
  return getTemplateMeta(client, collectiveId, templateId);
}
