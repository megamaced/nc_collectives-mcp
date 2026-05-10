import { COLLECTIVES_API, encodeWebDavPath, HttpError, type NextcloudClient } from './http.js';
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

// -----------------------------------------------------------------------------
// Page writes
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

/** A page is a "folder" iff its file is `Readme.md` (true for the landing page and any page with children). */
function isFolderPage(page: Page): boolean {
  return page.fileName === 'Readme.md';
}

/** Full WebDAV path to the page's content file. */
function pageFilePath(page: Page): string {
  return encodeWebDavPath(page.collectivePath, page.filePath, page.fileName);
}

/** Full WebDAV path to the directory holding a folder page. */
function folderDirPath(page: Page): string {
  return encodeWebDavPath(page.collectivePath, page.filePath);
}

async function findPageOrThrow(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<Page> {
  const pages = await listPages(client, collectiveId);
  const page = pages.find((p) => p.id === pageId);
  if (!page) throw new Error(`Page ${pageId} not found in collective ${collectiveId}`);
  return page;
}

/**
 * Promote a leaf page to a folder so it can hold children.
 *
 * Before: `<dir>/<Title>.md`
 * After:  `<dir>/<Title>/Readme.md`
 *
 * The page id is preserved (Nextcloud's fileId stays put across MOVE).
 */
async function promoteLeafToFolder(
  client: NextcloudClient,
  collectiveId: number,
  page: Page,
): Promise<Page> {
  if (isFolderPage(page)) return page;

  const titleNoExt = page.fileName.replace(/\.md$/i, '');
  const oldPath = encodeWebDavPath(page.collectivePath, page.filePath, page.fileName);
  const newDir = encodeWebDavPath(page.collectivePath, page.filePath, titleNoExt);
  const newPath = `${newDir}/Readme.md`;

  await client.webdav('MKCOL', `${newDir}/`);
  await client.webdav('MOVE', oldPath, undefined, {
    Destination: client.webdavUrl(newPath),
  });

  return findPageOrThrow(client, collectiveId, page.id);
}

export interface CreatePageInput {
  collectiveId: number;
  parentPageId: number;
  title: string;
  /** Markdown body. Empty string allowed. */
  body?: string;
  /** Optional emoji to set after creation. */
  emoji?: string;
}

/**
 * Create a new leaf page. If the parent is currently a leaf, it is first
 * promoted to a folder. Throws if a sibling with the same title already exists.
 */
export async function createPage(
  client: NextcloudClient,
  input: CreatePageInput,
): Promise<Page> {
  const cleanTitle = sanitizeTitle(input.title);
  let parent = await findPageOrThrow(client, input.collectiveId, input.parentPageId);

  if (!isFolderPage(parent)) {
    parent = await promoteLeafToFolder(client, input.collectiveId, parent);
  }

  const sibling = (await listPages(client, input.collectiveId)).find(
    (p) => p.parentId === parent.id && p.title === cleanTitle,
  );
  if (sibling) {
    throw new Error(`A page titled "${cleanTitle}" already exists under parent ${parent.id}`);
  }

  const childPath = encodeWebDavPath(parent.collectivePath, parent.filePath, `${cleanTitle}.md`);
  await client.webdav('PUT', childPath, input.body ?? '');

  const created = (await listPages(client, input.collectiveId)).find(
    (p) => p.parentId === parent.id && p.title === cleanTitle,
  );
  if (!created) {
    throw new Error(`Page "${cleanTitle}" was created but Collectives has not yet indexed it`);
  }

  if (input.emoji) {
    return setPageEmoji(client, input.collectiveId, created.id, input.emoji);
  }
  return created;
}

export type UpdateMode = 'replace' | 'append' | 'prepend';

/** Overwrite, append to, or prepend to a page's markdown body. */
export async function updatePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  body: string,
  mode: UpdateMode = 'replace',
): Promise<Page> {
  const page = await findPageOrThrow(client, collectiveId, pageId);
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
  return findPageOrThrow(client, collectiveId, pageId);
}

/**
 * Trash a page (recoverable from the Collectives page trash). The Landing
 * page (parentId 0) cannot be deleted — delete the Collective itself
 * instead. A 404 from OCS is treated as idempotent success: the page is
 * already gone.
 */
export async function deletePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<void> {
  // Resolve metadata first so we can give a useful error if the user tries
  // to delete the landing page.
  const pages = await listPages(client, collectiveId);
  const page = pages.find((p) => p.id === pageId);
  if (page && page.parentId === 0) {
    throw new Error('Cannot delete the Landing page; delete the Collective instead.');
  }

  try {
    await client.ocs(
      'DELETE',
      `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}`,
    );
  } catch (err) {
    // Idempotent: if the page is already gone, treat as success.
    if (err instanceof HttpError && err.status === 404) return;
    throw err;
  }
}

/** Rename a page within its current parent. */
export async function renamePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  newTitle: string,
): Promise<Page> {
  const cleanTitle = sanitizeTitle(newTitle);
  const page = await findPageOrThrow(client, collectiveId, pageId);
  if (page.parentId === 0) {
    throw new Error('Cannot rename the Landing page; rename the Collective instead.');
  }

  if (isFolderPage(page)) {
    // Folder page: rename the directory containing its Readme.md.
    const segs = page.filePath.split('/').filter(Boolean);
    segs[segs.length - 1] = cleanTitle;
    const oldDir = folderDirPath(page);
    const newDir = encodeWebDavPath(page.collectivePath, segs.join('/'));
    await client.webdav('MOVE', oldDir, undefined, {
      Destination: client.webdavUrl(newDir),
    });
  } else {
    const oldPath = pageFilePath(page);
    const newPath = encodeWebDavPath(page.collectivePath, page.filePath, `${cleanTitle}.md`);
    await client.webdav('MOVE', oldPath, undefined, {
      Destination: client.webdavUrl(newPath),
    });
  }
  return findPageOrThrow(client, collectiveId, pageId);
}

/** Move a page under a different parent within the same collective. */
export async function movePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  newParentPageId: number,
): Promise<Page> {
  const page = await findPageOrThrow(client, collectiveId, pageId);
  if (page.parentId === 0) {
    throw new Error('Cannot move the Landing page.');
  }
  if (page.id === newParentPageId) {
    throw new Error('Cannot move a page under itself.');
  }
  let newParent = await findPageOrThrow(client, collectiveId, newParentPageId);
  if (!isFolderPage(newParent)) {
    newParent = await promoteLeafToFolder(client, collectiveId, newParent);
  }

  if (isFolderPage(page)) {
    const titleSeg = page.filePath.split('/').filter(Boolean).pop() ?? page.title;
    const oldDir = folderDirPath(page);
    const newDirSegs = [newParent.filePath, titleSeg].filter(Boolean).join('/');
    const newDir = encodeWebDavPath(page.collectivePath, newDirSegs);
    await client.webdav('MOVE', oldDir, undefined, {
      Destination: client.webdavUrl(newDir),
    });
  } else {
    const oldPath = pageFilePath(page);
    const newPath = encodeWebDavPath(page.collectivePath, newParent.filePath, page.fileName);
    await client.webdav('MOVE', oldPath, undefined, {
      Destination: client.webdavUrl(newPath),
    });
  }
  return findPageOrThrow(client, collectiveId, pageId);
}

/** Set a single emoji icon on a page. Pass an empty string to clear. */
export async function setPageEmoji(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  emoji: string,
): Promise<Page> {
  await client.ocs(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/${pageId}/emoji`,
    { emoji },
  );
  return findPageOrThrow(client, collectiveId, pageId);
}

/**
 * Duplicate a leaf page within the same collective. Implemented via WebDAV
 * COPY because Collectives does not expose a copy endpoint in its OCS API.
 * The new page lands under the same parent as the source with " (copy)"
 * appended to the title; if `newTitle` is provided, that's used instead.
 *
 * Folder-page copies (whole subtrees) are not supported — call this only
 * on leaf pages. Promote / move the result manually if a different parent
 * is desired.
 */
export async function copyPage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  newTitle?: string,
): Promise<Page> {
  const page = await findPageOrThrow(client, collectiveId, pageId);
  if (isFolderPage(page)) {
    throw new Error(
      'copyPage currently supports only leaf pages — copying a folder page would duplicate its entire subtree which Collectives does not expose via API',
    );
  }

  const baseTitle = page.fileName.replace(/\.md$/i, '');
  const targetTitle = sanitizeTitle(newTitle ?? `${baseTitle} (copy)`);

  // Avoid colliding with an existing sibling.
  const siblings = (await listPages(client, collectiveId)).filter((p) => p.parentId === page.parentId);
  if (siblings.some((s) => s.title === targetTitle)) {
    throw new Error(`A page titled "${targetTitle}" already exists under parent ${page.parentId}`);
  }

  const oldPath = pageFilePath(page);
  const newPath = encodeWebDavPath(page.collectivePath, page.filePath, `${targetTitle}.md`);
  await client.webdav('COPY', oldPath, undefined, {
    Destination: client.webdavUrl(newPath),
  });

  const created = (await listPages(client, collectiveId)).find(
    (p) => p.parentId === page.parentId && p.title === targetTitle,
  );
  if (!created) {
    throw new Error(`Page "${targetTitle}" was copied but Collectives has not yet indexed it`);
  }
  return created;
}

/**
 * Get the current user's favorite page ids for a Collective. Reads the
 * `userFavoritePages` field on the Collective object.
 */
async function getFavoritePageIds(client: NextcloudClient, collectiveId: number): Promise<number[]> {
  const collective = (await listCollectives(client)).find((c) => c.id === collectiveId);
  if (!collective) throw new Error(`Collective ${collectiveId} not found`);
  // userFavoritePages isn't on the Collective interface — fetch via cast.
  return ((collective as unknown as { userFavoritePages?: number[] }).userFavoritePages ?? []).slice();
}

/**
 * Replace the favorites list for a Collective. The OCS endpoint takes a
 * JSON-stringified array (per the openapi spec) — odd but documented.
 */
async function setFavoritePageIds(
  client: NextcloudClient,
  collectiveId: number,
  pageIds: number[],
): Promise<void> {
  await client.ocs(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/userSettings/favoritePages`,
    { favoritePages: JSON.stringify(pageIds) },
  );
}

/** Mark a page as a favorite for the current user. */
export async function favoritePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<void> {
  const current = await getFavoritePageIds(client, collectiveId);
  if (current.includes(pageId)) return;
  await setFavoritePageIds(client, collectiveId, [...current, pageId]);
}

/** Remove a page from the current user's favorites. */
export async function unfavoritePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<void> {
  const current = await getFavoritePageIds(client, collectiveId);
  if (!current.includes(pageId)) return;
  await setFavoritePageIds(
    client,
    collectiveId,
    current.filter((id) => id !== pageId),
  );
}

export interface CollectiveTag {
  id: number;
  name: string;
  color?: string;
}

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

/** Add a single tag to a page. */
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
 * Replace the tags on a page with the given set of tag ids. Tags must
 * already exist in the Collective; use {@link listTags} to look them up
 * and create them via the Collectives UI if needed.
 *
 * Implemented as a diff against the page's current tags using the
 * per-tag PUT/DELETE endpoints (Collectives doesn't expose a bulk
 * setter).
 */
export async function setPageTags(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  tagIds: number[],
): Promise<Page> {
  const page = await findPageOrThrow(client, collectiveId, pageId);
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

  return findPageOrThrow(client, collectiveId, pageId);
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

/** Restore a page from the Collective trash. */
export async function restorePage(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<Page> {
  await client.ocs(
    'PUT',
    `${COLLECTIVES_API}/collectives/${collectiveId}/pages/trash/${pageId}`,
  );
  return findPageOrThrow(client, collectiveId, pageId);
}

/**
 * Permanently delete a trashed page. This is irreversible — the page
 * content cannot be recovered after this call.
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

export interface PageVersion {
  /** Version identifier (typically a timestamp or etag). */
  versionId: string;
  /** Size in bytes. */
  size: number;
  /** Last modified date string from the server. */
  lastModified: string;
}

/**
 * List available versions for a page. Uses Nextcloud's WebDAV versions API.
 * The page's file id is taken from the OCS metadata (the page `id` **is** the
 * Nextcloud file id in Collectives).
 */
export async function listPageVersions(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<PageVersion[]> {
  // Ensure the page exists.
  await findPageOrThrow(client, collectiveId, pageId);

  // Nextcloud file versions live at /remote.php/dav/versions/{user}/versions/{fileId}
  const res = await client.webdavVersions('PROPFIND', `/versions/${pageId}`, undefined, {
    Depth: '1',
  });
  const xml = await res.text();
  return parseVersionsXml(xml);
}

/**
 * Restore a specific version of a page by copying it back to the live path.
 * Uses WebDAV COPY from the versions area to the file's current location.
 */
export async function restorePageVersion(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  versionId: string,
): Promise<Page> {
  const page = await findPageOrThrow(client, collectiveId, pageId);
  const livePath = pageFilePath(page);
  const liveUrl = client.webdavUrl(livePath);

  await client.webdavVersions('COPY', `/versions/${pageId}/${versionId}`, undefined, {
    Destination: liveUrl,
    Overwrite: 'T',
  });

  return findPageOrThrow(client, collectiveId, pageId);
}

/** Parse a PROPFIND multistatus XML response for file versions. */
function parseVersionsXml(xml: string): PageVersion[] {
  const versions: PageVersion[] = [];
  // Match each <d:response> block (skip the first one which is the collection itself)
  const responseRegex = /<d:response>([\s\S]*?)<\/d:response>/g;
  let match: RegExpExecArray | null;
  let isFirst = true;
  while ((match = responseRegex.exec(xml)) !== null) {
    if (isFirst) {
      isFirst = false;
      continue; // Skip the collection entry itself.
    }
    const block = match[1]!;

    // Extract href to get the version id (last path segment).
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
 * Collectives does not expose a dedicated "recent" endpoint, so this fetches
 * the full page list and sorts client-side.
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
 * Get backlinks for a page — returns other pages that link to it.
 * Uses the `linkedPageIds` field on page metadata: scans all pages in
 * the collective and returns those whose `linkedPageIds` includes the target.
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
// Attachments
// -----------------------------------------------------------------------------

export interface Attachment {
  name: string;
  size: number;
  contentType: string;
  lastModified: string;
  /** Relative markdown reference path: `.attachments.{pageId}/{filename}` */
  relativePath: string;
}

/**
 * Resolve the WebDAV path to the `.attachments.{pageId}/` directory.
 *
 * For a **folder page** (fileName === Readme.md) the attachments dir lives
 * inside the page's own folder:
 *   `<collectivePath>/<filePath>/.attachments.<pageId>/`
 *
 * For a **leaf page** (`Title.md`) the attachments dir lives alongside
 * the page file in its parent directory:
 *   `<collectivePath>/<filePath>/.attachments.<pageId>/`
 *
 * Both cases resolve identically because `filePath` already points to the
 * containing directory for leaves (it's the parent's folder path).
 */
function attachmentsDirPath(page: Page): string {
  return encodeWebDavPath(page.collectivePath, page.filePath, `.attachments.${page.id}`);
}

/**
 * List attachments for a page. Returns an empty array if no attachments
 * directory exists yet.
 */
export async function listAttachments(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
): Promise<Attachment[]> {
  const page = await findPageOrThrow(client, collectiveId, pageId);
  const dirPath = attachmentsDirPath(page);

  let res: Response;
  try {
    res = await client.webdav('PROPFIND', `${dirPath}/`, undefined, { Depth: '1' });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return [];
    throw err;
  }

  const xml = await res.text();
  return parseAttachmentsXml(xml, page.id);
}

/**
 * Upload an attachment to a page. Creates the `.attachments.{pageId}/`
 * directory if it doesn't exist. Returns metadata including the relative
 * path to reference in markdown.
 */
export async function uploadAttachment(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  filename: string,
  content: Uint8Array | string,
  contentType?: string,
): Promise<Attachment> {
  const page = await findPageOrThrow(client, collectiveId, pageId);
  const cleanName = sanitizeAttachmentName(filename);
  const dirPath = attachmentsDirPath(page);

  // Ensure the directory exists (MKCOL is idempotent-ish; 405 = already exists).
  try {
    await client.webdav('MKCOL', `${dirPath}/`);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 405)) throw err;
  }

  const filePath = `${dirPath}/${encodeURIComponent(cleanName)}`;
  const headers: Record<string, string> = {};
  if (contentType) headers['Content-Type'] = contentType;

  await client.webdav('PUT', filePath, typeof content === 'string' ? content : content, headers);

  const size = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length;
  return {
    name: cleanName,
    size,
    contentType: contentType ?? 'application/octet-stream',
    lastModified: new Date().toUTCString(),
    relativePath: `.attachments.${pageId}/${cleanName}`,
  };
}

/** Delete an attachment from a page. */
export async function deleteAttachment(
  client: NextcloudClient,
  collectiveId: number,
  pageId: number,
  filename: string,
): Promise<void> {
  const page = await findPageOrThrow(client, collectiveId, pageId);
  const dirPath = attachmentsDirPath(page);
  const filePath = `${dirPath}/${encodeURIComponent(filename)}`;
  await client.webdav('DELETE', filePath);
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

/** Parse a PROPFIND response for the attachments directory. */
function parseAttachmentsXml(xml: string, pageId: number): Attachment[] {
  const attachments: Attachment[] = [];
  const responseRegex = /<d:response>([\s\S]*?)<\/d:response>/g;
  let match: RegExpExecArray | null;
  let isFirst = true;
  while ((match = responseRegex.exec(xml)) !== null) {
    if (isFirst) {
      isFirst = false;
      continue; // Skip the collection entry itself.
    }
    const block = match[1]!;

    const hrefMatch = /<d:href>([^<]+)<\/d:href>/.exec(block);
    if (!hrefMatch?.[1]) continue;
    const href = decodeURIComponent(hrefMatch[1]);
    const name = href.split('/').filter(Boolean).pop() ?? '';
    if (!name) continue;

    // Skip sub-collections (shouldn't exist, but guard).
    if (/<d:resourcetype>\s*<d:collection/.test(block)) continue;

    const sizeMatch = /<d:getcontentlength>(\d+)<\/d:getcontentlength>/.exec(block);
    const size = sizeMatch?.[1] ? parseInt(sizeMatch[1], 10) : 0;

    const mimeMatch = /<d:getcontenttype>([^<]+)<\/d:getcontenttype>/.exec(block);
    const contentType = mimeMatch?.[1] ?? 'application/octet-stream';

    const modMatch = /<d:getlastmodified>([^<]+)<\/d:getlastmodified>/.exec(block);
    const lastModified = modMatch?.[1] ?? '';

    attachments.push({
      name,
      size,
      contentType,
      lastModified,
      relativePath: `.attachments.${pageId}/${name}`,
    });
  }
  return attachments;
}
