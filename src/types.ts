/** A Nextcloud Collective as returned by `GET /collectives`. */
export interface Collective {
  id: number;
  slug: string;
  name: string;
  emoji: string | null;
  level: number;
  /** 0 = members, 1 = moderators, etc. */
  editPermissionLevel: number;
  sharePermissionLevel: number;
  canEdit: boolean;
  canShare: boolean;
  shareToken: string | null;
  isPageShare: boolean;
  trashTimestamp: number | null;
  circleUniqueId?: string;
  permissions?: number;
  /** 0 = view, 1 = edit. */
  pageMode?: number;
  canLeave?: boolean;
  userPageOrder?: number;
  userShowMembers?: boolean;
  userShowRecentPages?: boolean;
  userFavoritePages?: number[];
}

/** A page within a Collective as returned by `GET /collectives/{id}/pages`. */
export interface Page {
  id: number;
  slug: string;
  title: string;
  emoji: string | null;
  parentId: number;
  /** Order of immediate children by page id. Empty for leaf pages. */
  subpageOrder: number[];
  isFullWidth: boolean;
  /**
   * Tag IDs attached to the page. The server returns numeric ids here, not
   * names — resolve to display names via `listTags(collectiveId)` when
   * rendering. (The interface previously typed this as `string[]`, but
   * TypeScript erases types at runtime so the field actually held numbers;
   * any code that compared values to names silently misbehaved.)
   */
  tags: number[];
  trashTimestamp: number | null;
  /** Modification timestamp in seconds since epoch. */
  timestamp: number;
  size: number;
  /** Filename within the collective folder, e.g. `Readme.md` or `Title.md`. */
  fileName: string;
  /** Path within the collective, with no leading or trailing slash. Empty string for top-level pages. */
  filePath: string;
  filePathString: string;
  /** Absolute path within the user's Files area, e.g. `.Collectives/Wiki`. */
  collectivePath: string;
  collectiveNameWithEmoji: string | null;
  shareToken: string | null;
  /** IDs of pages this page links to. Populated by Collectives when known. */
  linkedPageIds: number[];
  lastUserId: string;
  lastUserDisplayName: string;
}

/** A tag defined within a Collective. */
export interface CollectiveTag {
  id: number;
  collectiveId?: number;
  name: string;
  color?: string;
}

/**
 * A public share link, as returned by the Collectives shares endpoints. One
 * shape covers both kinds: `pageId` is 0 for a Collective-wide share and the
 * page's id for a page share.
 *
 * The server echoes `password` back on create/update. Treat it as write-only —
 * `tools.ts` redacts it before anything reaches the MCP client.
 */
export interface CollectiveShare {
  id: number;
  collectiveId: number;
  /** 0 for a Collective-level share; otherwise the shared page's id. */
  pageId: number;
  token: string;
  owner: string;
  editable: boolean;
  password: string;
}

/** An attachment on a page, as returned by the OCS attachments endpoint. */
export interface PageAttachment {
  id: number;
  pageId: number;
  name: string;
  filesize: number;
  mimetype: string;
  timestamp: number;
  hasPreview?: boolean;
  /** Path within the user's Files area. Present on OCS list responses. */
  path?: string;
  /** Path relative to the Collective root. Present on OCS list responses. */
  internalPath?: string;
}

/** A historical version of a page from the WebDAV versions API. */
export interface PageVersion {
  versionId: string;
  size: number;
  lastModified: string;
}
