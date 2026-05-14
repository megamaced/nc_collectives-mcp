import { COLLECTIVES_API, encodeWebDavPath, HttpError, type NextcloudClient } from './http.js';
import type { Collective, CollectiveTag, Page, PageAttachment, PageVersion } from './types.js';

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
// Filename sanitisation (kept for attachment filenames)
// -----------------------------------------------------------------------------

const FORBIDDEN_FILENAME_CHARS = /[/\\:*?"<>|\x00-\x1f]/g;
const MAX_FILENAME_BYTES = 250;

/**
 * Convert a page title to a filesystem-safe basename. Strips path separators
 * and control characters, collapses whitespace, refuses empty or `.`/`..`,
 * and enforces a 250-byte cap (room for `.md` under the typical 255-byte limit).
 */
export function sanitizeTitle(title: string): string {
  const cleaned = title.replace(FORBIDDEN_FILENAME_CHARS, '-').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    throw new Error('Page title cannot be empty after sanitization');
  }
  if (cleaned === '.' || cleaned === '..') {
    throw new Error(`Invalid page title: "${title}"`);
  }
  if (Buffer.byteLength(`${cleaned}.md`, 'utf8') > MAX_FILENAME_BYTES) {
    throw new Error(`Page title too long; "${cleaned}.md" exceeds ${MAX_FILENAME_BYTES} bytes`);
  }
  return cleaned;
}

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

  if (input.body) {
    const path = pageFilePath(page);
    await client.webdav('PUT', path, input.body);
  }

  if (input.emoji) {
    page = await setPageEmoji(client, input.collectiveId, page.id, input.emoji);
  }

  return page;
}

export type UpdateMode = 'replace' | 'append' | 'prepend';

/** Overwrite, append to, or prepend to a page's markdown body via WebDAV. */
export async function updatePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  body: string,
  mode: UpdateMode = 'replace',
): Promise<Page> {
  const page = await getPageMeta(client, collectiveId, pageId);
  const path = pageFilePath(page);

  let newBody = body;
  if (mode !== 'replace') {
    const existing = await (await client.webdav('GET', path)).text();
    if (mode === 'append') {
      const sep = existing.endsWith('\n') ? '' : '\n';
      newBody = `${existing}${sep}${body}`;
    } else {
      const sep = body.endsWith('\n') ? '' : '\n';
      newBody = `${body}${sep}${existing}`;
    }
  }
  await client.webdav('PUT', path, newBody);
  return getPageMeta(client, collectiveId, pageId);
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
  const page = await getPageMeta(client, collectiveId, pageId);
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
 * Per the OpenAPI spec: `PUT .../pages/{id}` with `{parentId}` in body.
 */
export async function movePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  newParentPageId: number,
): Promise<Page> {
  const data = await client.ocs<{ page: Page }>(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}`,
    { parentId: newParentPageId },
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
): Promise<Page> {
  const body: Record<string, unknown> = { copy: true };
  if (newTitle) body.title = newTitle;
  const data = await client.ocs<{ page: Page }>(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}`,
    body,
  );
  return data.page;
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

/** Strip leading `#` from a hex colour — the DB column is varchar(6). */
function normalizeColor(color: string): string {
  return color.replace(/^#/, '');
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
  const allTags = await listTags(client, collectiveId);
  const nameToId = new Map(allTags.map((t) => [t.name, t.id]));
  const currentTagIds = new Set(
    (page.tags ?? []).flatMap((name) => {
      const id = nameToId.get(name);
      return id !== undefined ? [id] : [];
    }),
  );
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
 * Restore a specific version of a page by copying it back to the live path.
 * The `versionId` is URI-encoded to prevent path traversal.
 */
export async function restorePageVersion(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  versionId: string,
): Promise<Page> {
  const page = await getPageMeta(client, collectiveId, pageId);
  const livePath = pageFilePath(page);
  const liveUrl = client.webdavUrl(livePath);
  const safeVersionId = encodeURIComponent(versionId);

  await client.webdavVersions('COPY', `/versions/${pageId}/${safeVersionId}`, undefined, {
    Destination: liveUrl,
    Overwrite: 'T',
  });

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

/** Delete an attachment from a page via WebDAV. */
export async function deleteAttachment(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  filename: string,
): Promise<void> {
  const page = await getPageMeta(client, collectiveId, pageId);
  const dirPath = attachmentsDirPath(page);
  const filePath = `${dirPath}/${encodeURIComponent(filename)}`;
  await client.webdav('DELETE', filePath);
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
 * Per the OpenAPI spec: `POST .../pages/templates/{parentId}` with `{title}` in body.
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
    { title },
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
