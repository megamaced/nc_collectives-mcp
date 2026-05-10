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
  tags: string[];
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
