import { z, type ZodTypeAny } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  copyPage,
  createCollective,
  createPage,
  deleteCollective,
  deletePage,
  favoritePage,
  getBacklinks,
  getPage,
  listCollectives,
  listPages,
  listPageVersions,
  listRecentPages,
  listTags,
  listTrashedPages,
  movePage,
  purgePage,
  renamePage,
  restorePage,
  restorePageVersion,
  searchPages,
  setPageEmoji,
  setPageTags,
  unfavoritePage,
  updateCollective,
  updatePage,
} from './api.js';
import { HttpError, OcsError, type NextcloudClient } from './http.js';

interface Context {
  client: NextcloudClient;
  configSummary: string;
}

interface ToolDef<S extends ZodTypeAny> {
  tool: Tool;
  argsSchema: S;
  handler: (args: z.infer<S>, ctx: Context) => Promise<CallToolResult>;
}

const Empty = z.object({}).strict();

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

// -----------------------------------------------------------------------------
// Tool definitions
// -----------------------------------------------------------------------------

const ping: ToolDef<typeof Empty> = {
  argsSchema: Empty,
  tool: {
    name: 'ping',
    description:
      'Verify connectivity to the configured Nextcloud instance and report how many collectives are visible.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  handler: async (_args, ctx) => {
    const collectives = await listCollectives(ctx.client);
    return textResult(
      `OK — connected to ${ctx.configSummary}; ${collectives.length} collective(s) visible.`,
    );
  },
};

const listCollectivesTool: ToolDef<typeof Empty> = {
  argsSchema: Empty,
  tool: {
    name: 'list_collectives',
    description:
      'List all Collectives the authenticated user has access to. Returns id, name, slug, emoji, and permission levels.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  handler: async (_args, ctx) => jsonResult(await listCollectives(ctx.client)),
};

const CreateCollectiveArgs = z
  .object({
    name: z.string().min(1, 'name is required'),
    emoji: z.string().optional(),
  })
  .strict();

const createCollectiveTool: ToolDef<typeof CreateCollectiveArgs> = {
  argsSchema: CreateCollectiveArgs,
  tool: {
    name: 'create_collective',
    description:
      'Create a new Collective. Also creates the underlying Nextcloud Team. Optionally set an emoji icon.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Collective name (becomes the folder name in Files).' },
        emoji: { type: 'string', description: 'Optional single emoji to set as the icon.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) => jsonResult(await createCollective(ctx.client, args)),
};

const UpdateCollectiveArgs = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1).optional(),
    emoji: z.string().optional(),
    editPermissionLevel: z.number().int().optional(),
    sharePermissionLevel: z.number().int().optional(),
  })
  .strict()
  .refine(
    (a) =>
      a.name !== undefined ||
      a.emoji !== undefined ||
      a.editPermissionLevel !== undefined ||
      a.sharePermissionLevel !== undefined,
    { message: 'At least one of name, emoji, editPermissionLevel, sharePermissionLevel must be provided' },
  );

const updateCollectiveTool: ToolDef<typeof UpdateCollectiveArgs> = {
  argsSchema: UpdateCollectiveArgs,
  tool: {
    name: 'update_collective',
    description:
      'Rename a Collective, change its emoji, or adjust edit/share permission levels. Provide the id and any fields to change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Collective id from list_collectives.' },
        name: { type: 'string' },
        emoji: { type: 'string', description: 'Set to empty string to clear.' },
        editPermissionLevel: { type: 'integer' },
        sharePermissionLevel: { type: 'integer' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) => {
    const { id, ...patch } = args;
    return jsonResult(await updateCollective(ctx.client, id, patch));
  },
};

const DeleteCollectiveArgs = z
  .object({
    id: z.number().int().positive(),
    deleteTeam: z.boolean().optional(),
  })
  .strict();

const deleteCollectiveTool: ToolDef<typeof DeleteCollectiveArgs> = {
  argsSchema: DeleteCollectiveArgs,
  tool: {
    name: 'delete_collective',
    description:
      'Soft-delete a Collective (recoverable from the Collectives trash). By default also deletes the underlying Nextcloud Team — set deleteTeam=false to keep it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        deleteTeam: {
          type: 'boolean',
          description: 'Default true. When false, the Team (Circle) is kept and only the Collective is removed.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) => {
    await deleteCollective(ctx.client, args.id, { deleteTeam: args.deleteTeam });
    return textResult(`Collective ${args.id} moved to trash${args.deleteTeam === false ? '' : ' (Team also deleted)'}.`);
  },
};

const ListPagesArgs = z
  .object({
    collectiveId: z.number().int().positive(),
  })
  .strict();

const listPagesTool: ToolDef<typeof ListPagesArgs> = {
  argsSchema: ListPagesArgs,
  tool: {
    name: 'list_pages',
    description:
      'List all pages in a Collective. Returns flat metadata (id, title, parentId, emoji, tags, timestamps, paths). Use parentId to reconstruct the tree.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer', description: 'Collective id from list_collectives.' },
      },
      required: ['collectiveId'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) => jsonResult(await listPages(ctx.client, args.collectiveId)),
};

const GetPageArgs = z
  .object({
    collectiveId: z.number().int().positive(),
    pageId: z.number().int().positive(),
  })
  .strict();

const getPageTool: ToolDef<typeof GetPageArgs> = {
  argsSchema: GetPageArgs,
  tool: {
    name: 'get_page',
    description:
      'Fetch a page as markdown. Returns the metadata block followed by the page body.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
      },
      required: ['collectiveId', 'pageId'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) => {
    const { page, markdown } = await getPage(ctx.client, args.collectiveId, args.pageId);
    const header = [
      `# ${page.emoji ? page.emoji + ' ' : ''}${page.title}`,
      '',
      `- id: ${page.id}`,
      `- parentId: ${page.parentId}`,
      `- path: ${page.collectivePath}/${page.filePath ? page.filePath + '/' : ''}${page.fileName}`,
      `- last edited: ${page.lastUserDisplayName} at ${new Date(page.timestamp * 1000).toISOString()}`,
      `- size: ${page.size} bytes`,
      page.tags.length ? `- tags: ${page.tags.join(', ')}` : '',
      '',
      '---',
      '',
    ]
      .filter((l) => l !== '')
      .join('\n');
    return textResult(`${header}\n\n${markdown}`);
  },
};

const SearchArgs = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const searchTool: ToolDef<typeof SearchArgs> = {
  argsSchema: SearchArgs,
  tool: {
    name: 'search',
    description:
      'Full-text search across all Collectives pages the user can access. Uses the Nextcloud unified search "collectives-pages" provider.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term.' },
        limit: { type: 'integer', description: 'Maximum results to return (default 25).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await searchPages(ctx.client, args.query, args.limit)),
};

// -----------------------------------------------------------------------------
// Page write tools
// -----------------------------------------------------------------------------

const CreatePageArgs = z
  .object({
    collectiveId: z.number().int().positive(),
    parentPageId: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string().optional(),
    emoji: z.string().optional(),
  })
  .strict();

const createPageTool: ToolDef<typeof CreatePageArgs> = {
  argsSchema: CreatePageArgs,
  tool: {
    name: 'create_page',
    description:
      'Create a new page under a parent. If the parent is a leaf page, it is automatically promoted to a folder so it can hold children. Refuses to overwrite a sibling with the same title.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        parentPageId: {
          type: 'integer',
          description: 'Parent page id. To create at the root, pass the Landing page id.',
        },
        title: { type: 'string', description: 'Page title; becomes the filename.' },
        body: { type: 'string', description: 'Markdown body. Optional.' },
        emoji: { type: 'string', description: 'Optional single emoji to set as the icon.' },
      },
      required: ['collectiveId', 'parentPageId', 'title'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) => jsonResult(await createPage(ctx.client, args)),
};

const UpdatePageArgs = z
  .object({
    collectiveId: z.number().int().positive(),
    pageId: z.number().int().positive(),
    body: z.string(),
    mode: z.enum(['replace', 'append', 'prepend']).optional(),
  })
  .strict();

const updatePageTool: ToolDef<typeof UpdatePageArgs> = {
  argsSchema: UpdatePageArgs,
  tool: {
    name: 'update_page',
    description:
      'Replace, append to, or prepend to a page\'s markdown body. Mode defaults to "replace".',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        body: { type: 'string' },
        mode: { type: 'string', enum: ['replace', 'append', 'prepend'] },
      },
      required: ['collectiveId', 'pageId', 'body'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await updatePage(ctx.client, args.collectiveId, args.pageId, args.body, args.mode)),
};

const DeletePageArgs = z
  .object({
    collectiveId: z.number().int().positive(),
    pageId: z.number().int().positive(),
  })
  .strict();

const deletePageTool: ToolDef<typeof DeletePageArgs> = {
  argsSchema: DeletePageArgs,
  tool: {
    name: 'delete_page',
    description:
      'Trash a page (recoverable from the Nextcloud Files trash). Folder pages take their entire subtree with them. The Landing page cannot be deleted — delete the collective itself instead.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
      },
      required: ['collectiveId', 'pageId'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) => {
    await deletePage(ctx.client, args.collectiveId, args.pageId);
    return textResult(`Page ${args.pageId} moved to trash.`);
  },
};

const RenamePageArgs = z
  .object({
    collectiveId: z.number().int().positive(),
    pageId: z.number().int().positive(),
    newTitle: z.string().min(1),
  })
  .strict();

const renamePageTool: ToolDef<typeof RenamePageArgs> = {
  argsSchema: RenamePageArgs,
  tool: {
    name: 'rename_page',
    description: 'Rename a page within its current parent.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        newTitle: { type: 'string' },
      },
      required: ['collectiveId', 'pageId', 'newTitle'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await renamePage(ctx.client, args.collectiveId, args.pageId, args.newTitle)),
};

const MovePageArgs = z
  .object({
    collectiveId: z.number().int().positive(),
    pageId: z.number().int().positive(),
    newParentPageId: z.number().int().positive(),
  })
  .strict();

const movePageTool: ToolDef<typeof MovePageArgs> = {
  argsSchema: MovePageArgs,
  tool: {
    name: 'move_page',
    description:
      'Move a page to a new parent within the same collective. If the new parent is a leaf, it is promoted first.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        newParentPageId: { type: 'integer' },
      },
      required: ['collectiveId', 'pageId', 'newParentPageId'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(
      await movePage(ctx.client, args.collectiveId, args.pageId, args.newParentPageId),
    ),
};

const SetPageEmojiArgs = z
  .object({
    collectiveId: z.number().int().positive(),
    pageId: z.number().int().positive(),
    emoji: z.string(),
  })
  .strict();

const setPageEmojiTool: ToolDef<typeof SetPageEmojiArgs> = {
  argsSchema: SetPageEmojiArgs,
  tool: {
    name: 'set_page_emoji',
    description: 'Set the single-emoji icon on a page. Pass an empty string to clear.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        emoji: { type: 'string', description: 'A single emoji, or "" to clear.' },
      },
      required: ['collectiveId', 'pageId', 'emoji'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await setPageEmoji(ctx.client, args.collectiveId, args.pageId, args.emoji)),
};

const CopyPageArgs = z
  .object({
    collectiveId: z.number().int().positive(),
    pageId: z.number().int().positive(),
    newTitle: z.string().min(1).optional(),
  })
  .strict();

const copyPageTool: ToolDef<typeof CopyPageArgs> = {
  argsSchema: CopyPageArgs,
  tool: {
    name: 'copy_page',
    description:
      'Duplicate a leaf page under the same parent. Defaults the new title to "<original> (copy)" unless newTitle is provided. Folder pages (those that contain children) cannot be copied.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        newTitle: { type: 'string', description: 'Title for the copy. Defaults to "<original> (copy)".' },
      },
      required: ['collectiveId', 'pageId'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await copyPage(ctx.client, args.collectiveId, args.pageId, args.newTitle)),
};

const PageRefArgs = z
  .object({
    collectiveId: z.number().int().positive(),
    pageId: z.number().int().positive(),
  })
  .strict();

const favoritePageTool: ToolDef<typeof PageRefArgs> = {
  argsSchema: PageRefArgs,
  tool: {
    name: 'favorite_page',
    description: 'Mark a page as a favorite for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: { collectiveId: { type: 'integer' }, pageId: { type: 'integer' } },
      required: ['collectiveId', 'pageId'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) => {
    await favoritePage(ctx.client, args.collectiveId, args.pageId);
    return textResult(`Page ${args.pageId} favorited.`);
  },
};

const unfavoritePageTool: ToolDef<typeof PageRefArgs> = {
  argsSchema: PageRefArgs,
  tool: {
    name: 'unfavorite_page',
    description: 'Remove a page from the authenticated user\'s favorites.',
    inputSchema: {
      type: 'object',
      properties: { collectiveId: { type: 'integer' }, pageId: { type: 'integer' } },
      required: ['collectiveId', 'pageId'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) => {
    await unfavoritePage(ctx.client, args.collectiveId, args.pageId);
    return textResult(`Page ${args.pageId} unfavorited.`);
  },
};

const ListTagsArgs = z
  .object({
    collectiveId: z.number().int().positive(),
  })
  .strict();

const listTagsTool: ToolDef<typeof ListTagsArgs> = {
  argsSchema: ListTagsArgs,
  tool: {
    name: 'list_tags',
    description: 'List all tags defined for a Collective.',
    inputSchema: {
      type: 'object',
      properties: { collectiveId: { type: 'integer' } },
      required: ['collectiveId'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) => jsonResult(await listTags(ctx.client, args.collectiveId)),
};

const SetPageTagsArgs = z
  .object({
    collectiveId: z.number().int().positive(),
    pageId: z.number().int().positive(),
    tagIds: z.array(z.number().int().nonnegative()),
  })
  .strict();

const setPageTagsTool: ToolDef<typeof SetPageTagsArgs> = {
  argsSchema: SetPageTagsArgs,
  tool: {
    name: 'set_page_tags',
    description:
      'Replace the tags on a page. Tags must already exist in the Collective; pass tag ids (use list_tags to look them up).',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        tagIds: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Replacement set of tag ids; pass [] to clear all tags.',
        },
      },
      required: ['collectiveId', 'pageId', 'tagIds'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await setPageTags(ctx.client, args.collectiveId, args.pageId, args.tagIds)),
};

// -----------------------------------------------------------------------------
// Trash tools
// -----------------------------------------------------------------------------

const listTrashedPagesTool: ToolDef<typeof ListPagesArgs> = {
  argsSchema: ListPagesArgs,
  tool: {
    name: 'list_trashed_pages',
    description:
      'List pages in the trash for a Collective. These can be restored or permanently purged.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer', description: 'Collective id from list_collectives.' },
      },
      required: ['collectiveId'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) => jsonResult(await listTrashedPages(ctx.client, args.collectiveId)),
};

const restorePageTool: ToolDef<typeof PageRefArgs> = {
  argsSchema: PageRefArgs,
  tool: {
    name: 'restore_page',
    description: 'Restore a trashed page back to its original location.',
    inputSchema: {
      type: 'object',
      properties: { collectiveId: { type: 'integer' }, pageId: { type: 'integer' } },
      required: ['collectiveId', 'pageId'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await restorePage(ctx.client, args.collectiveId, args.pageId)),
};

const purgePageTool: ToolDef<typeof PageRefArgs> = {
  argsSchema: PageRefArgs,
  tool: {
    name: 'purge_page',
    description:
      'Permanently delete a trashed page. THIS IS IRREVERSIBLE — the page content cannot be recovered after this call. The page must already be in the trash (use delete_page first).',
    inputSchema: {
      type: 'object',
      properties: { collectiveId: { type: 'integer' }, pageId: { type: 'integer' } },
      required: ['collectiveId', 'pageId'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) => {
    await purgePage(ctx.client, args.collectiveId, args.pageId);
    return textResult(`Page ${args.pageId} permanently deleted. This cannot be undone.`);
  },
};

// -----------------------------------------------------------------------------
// Version tools
// -----------------------------------------------------------------------------

const listPageVersionsTool: ToolDef<typeof PageRefArgs> = {
  argsSchema: PageRefArgs,
  tool: {
    name: 'list_page_versions',
    description:
      'List available versions (revision history) for a page. Returns version ids that can be used with restore_page_version.',
    inputSchema: {
      type: 'object',
      properties: { collectiveId: { type: 'integer' }, pageId: { type: 'integer' } },
      required: ['collectiveId', 'pageId'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await listPageVersions(ctx.client, args.collectiveId, args.pageId)),
};

const RestorePageVersionArgs = z
  .object({
    collectiveId: z.number().int().positive(),
    pageId: z.number().int().positive(),
    versionId: z.string().min(1),
  })
  .strict();

const restorePageVersionTool: ToolDef<typeof RestorePageVersionArgs> = {
  argsSchema: RestorePageVersionArgs,
  tool: {
    name: 'restore_page_version',
    description:
      'Restore a specific historical version of a page. The current content is replaced with the selected version (the current version is preserved as a new version entry).',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        versionId: { type: 'string', description: 'Version id from list_page_versions.' },
      },
      required: ['collectiveId', 'pageId', 'versionId'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(
      await restorePageVersion(ctx.client, args.collectiveId, args.pageId, args.versionId),
    ),
};

// -----------------------------------------------------------------------------
// Recent pages & backlinks
// -----------------------------------------------------------------------------

const ListRecentPagesArgs = z
  .object({
    collectiveId: z.number().int().positive(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const listRecentPagesTool: ToolDef<typeof ListRecentPagesArgs> = {
  argsSchema: ListRecentPagesArgs,
  tool: {
    name: 'list_recent_pages',
    description: 'List recently-modified pages for a Collective, ordered by last edit time.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer', description: 'Collective id from list_collectives.' },
        limit: { type: 'integer', description: 'Maximum pages to return (default 25, max 100).' },
      },
      required: ['collectiveId'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await listRecentPages(ctx.client, args.collectiveId, args.limit)),
};

const getBacklinksTool: ToolDef<typeof PageRefArgs> = {
  argsSchema: PageRefArgs,
  tool: {
    name: 'get_backlinks',
    description:
      'Find pages that link to the given page. Scans the linkedPageIds field on all pages in the Collective.',
    inputSchema: {
      type: 'object',
      properties: { collectiveId: { type: 'integer' }, pageId: { type: 'integer' } },
      required: ['collectiveId', 'pageId'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await getBacklinks(ctx.client, args.collectiveId, args.pageId)),
};

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

const REGISTRY = {
  ping,
  list_collectives: listCollectivesTool,
  create_collective: createCollectiveTool,
  update_collective: updateCollectiveTool,
  delete_collective: deleteCollectiveTool,
  list_pages: listPagesTool,
  get_page: getPageTool,
  search: searchTool,
  create_page: createPageTool,
  update_page: updatePageTool,
  delete_page: deletePageTool,
  rename_page: renamePageTool,
  move_page: movePageTool,
  set_page_emoji: setPageEmojiTool,
  copy_page: copyPageTool,
  favorite_page: favoritePageTool,
  unfavorite_page: unfavoritePageTool,
  list_tags: listTagsTool,
  set_page_tags: setPageTagsTool,
  list_trashed_pages: listTrashedPagesTool,
  restore_page: restorePageTool,
  purge_page: purgePageTool,
  list_page_versions: listPageVersionsTool,
  restore_page_version: restorePageVersionTool,
  list_recent_pages: listRecentPagesTool,
  get_backlinks: getBacklinksTool,
} as const;

export const TOOLS: Tool[] = Object.values(REGISTRY).map((t) => t.tool);

export async function dispatchTool(
  name: string,
  rawArgs: unknown,
  ctx: Context,
): Promise<CallToolResult> {
  const def = (REGISTRY as unknown as Record<string, ToolDef<ZodTypeAny>>)[name];
  if (!def) {
    return errorResult(`Unknown tool: ${name}`);
  }

  const parseResult = def.argsSchema.safeParse(rawArgs ?? {});
  if (!parseResult.success) {
    return errorResult(
      `Invalid arguments for ${name}: ${parseResult.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
  }

  try {
    return await def.handler(parseResult.data, ctx);
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResult(`${err.message}`);
    }
    if (err instanceof OcsError) {
      return errorResult(`${err.message}`);
    }
    if (err instanceof Error) {
      return errorResult(err.message);
    }
    return errorResult(String(err));
  }
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}
