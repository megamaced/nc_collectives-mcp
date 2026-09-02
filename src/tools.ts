import { z, type ZodTypeAny } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  copyPage,
  createCollective,
  createCollectiveShare,
  createPage,
  createPageShare,
  createTag,
  createTemplate,
  deleteAttachment,
  deleteCollective,
  deleteCollectiveShare,
  deletePage,
  deletePageShare,
  deleteTag,
  deleteTemplate,
  favoritePage,
  getAttachment,
  getBacklinks,
  getPage,
  getTemplate,
  isTextualMimeType,
  listAttachments,
  listCollectives,
  listPages,
  listPageVersions,
  listRecentPages,
  listShares,
  listTags,
  listTemplates,
  listTrashedCollectives,
  listTrashedPages,
  movePage,
  movePageToCollective,
  permanentlyDeleteCollective,
  purgePage,
  renameAttachment,
  renamePage,
  restoreAttachment,
  restorePage,
  restorePageVersion,
  restoreTrashedCollective,
  searchPages,
  searchPagesInCollective,
  setPageEmoji,
  setPageFullWidth,
  setPageMode,
  setPageTags,
  setSubpageOrder,
  setTemplateEmoji,
  setUserPageOrder,
  setUserShowMembers,
  setUserShowRecentPages,
  touchPage,
  unfavoritePage,
  updateCollective,
  updateCollectiveShare,
  updatePage,
  updatePageShare,
  updateTag,
  updateTemplate,
  updateTemplateContent,
  uploadAttachment,
} from './api.js';
import { HttpError, OcsError, type NextcloudClient } from './http.js';
import type { CollectiveShare, PageAttachment } from './types.js';

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

/**
 * Encode an attachment filename for use inside a URL path segment, matching
 * the encoder the Collectives editor uses (`src/util/attachmentFilename.ts`),
 * which additionally escapes the `!'()*` that `encodeURIComponent` leaves bare.
 */
export function encodeAttachmentFilename(filename: string): string {
  return encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Add a `relativePath` to each attachment for convenience. The path is
 * percent-encoded so it can be dropped straight into a markdown link
 * destination — a raw name containing a space, `#`, or `)` would otherwise
 * truncate the link or be read as a URL fragment.
 */
function withRelativePath(att: PageAttachment, pageId: number): PageAttachment & { relativePath: string } {
  return {
    ...att,
    relativePath: `.attachments.${pageId}/${encodeAttachmentFilename(att.name)}`,
  };
}

// -----------------------------------------------------------------------------
// Ping
// -----------------------------------------------------------------------------

const ping: ToolDef<typeof Empty> = {
  argsSchema: Empty,
  tool: {
    name: 'ping',
    description:
      'Verify connectivity to the configured Nextcloud instance and report how many collectives are visible.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: {
      title: 'Check connection',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (_args, ctx) => {
    const collectives = await listCollectives(ctx.client);
    return textResult(
      `OK — connected to ${ctx.configSummary}; ${collectives.length} collective(s) visible.`,
    );
  },
};

// -----------------------------------------------------------------------------
// Collective tools
// -----------------------------------------------------------------------------

const listCollectivesTool: ToolDef<typeof Empty> = {
  argsSchema: Empty,
  tool: {
    name: 'list_collectives',
    description:
      'List all Collectives the authenticated user has access to. Returns id, name, slug, emoji, and permission levels.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: {
      title: 'List Collectives',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
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
    annotations: {
      title: 'Create Collective',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => jsonResult(await createCollective(ctx.client, args)),
};

const UpdateCollectiveArgs = z
  .object({
    id: z.coerce.number().int().positive(),
    emoji: z.string().optional(),
    editPermissionLevel: z.coerce.number().int().optional(),
    sharePermissionLevel: z.coerce.number().int().optional(),
  })
  .strict()
  .refine(
    (a) =>
      a.emoji !== undefined ||
      a.editPermissionLevel !== undefined ||
      a.sharePermissionLevel !== undefined,
    { message: 'At least one of emoji, editPermissionLevel, sharePermissionLevel must be provided' },
  );

const updateCollectiveTool: ToolDef<typeof UpdateCollectiveArgs> = {
  argsSchema: UpdateCollectiveArgs,
  tool: {
    name: 'update_collective',
    description:
      'Change a Collective\'s emoji or adjust edit/share permission levels. Provide the id and any fields to change. Note: collective renaming is not supported by the API.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Collective id from list_collectives.' },
        emoji: { type: 'string', description: 'Set to empty string to clear.' },
        editPermissionLevel: { type: 'integer' },
        sharePermissionLevel: { type: 'integer' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Update Collective',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const { id, ...patch } = args;
    return jsonResult(await updateCollective(ctx.client, id, patch));
  },
};

const DeleteCollectiveArgs = z
  .object({
    id: z.coerce.number().int().positive(),
  })
  .strict();

const deleteCollectiveTool: ToolDef<typeof DeleteCollectiveArgs> = {
  argsSchema: DeleteCollectiveArgs,
  tool: {
    name: 'delete_collective',
    description:
      'Soft-delete a Collective (moves it to the Collectives trash, recoverable). Use permanently_delete_collective to remove it permanently and optionally delete the underlying Team.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Trash Collective',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    await deleteCollective(ctx.client, args.id);
    return textResult(`Collective ${args.id} moved to trash.`);
  },
};

// -----------------------------------------------------------------------------
// Collective trash tools
// -----------------------------------------------------------------------------

const listTrashedCollectivesTool: ToolDef<typeof Empty> = {
  argsSchema: Empty,
  tool: {
    name: 'list_trashed_collectives',
    description:
      'List Collectives that have been soft-deleted. These can be restored or permanently deleted.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: {
      title: 'List trashed Collectives',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (_args, ctx) => jsonResult(await listTrashedCollectives(ctx.client)),
};

const RestoreTrashedCollectiveArgs = z
  .object({ id: z.coerce.number().int().positive() })
  .strict();

const restoreTrashedCollectiveTool: ToolDef<typeof RestoreTrashedCollectiveArgs> = {
  argsSchema: RestoreTrashedCollectiveArgs,
  tool: {
    name: 'restore_trashed_collective',
    description: 'Restore a soft-deleted Collective from the trash.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Collective id from list_trashed_collectives.' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Restore Collective',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await restoreTrashedCollective(ctx.client, args.id)),
};

const PermanentlyDeleteCollectiveArgs = z
  .object({
    id: z.coerce.number().int().positive(),
    deleteTeam: z.boolean().optional(),
  })
  .strict();

const permanentlyDeleteCollectiveTool: ToolDef<typeof PermanentlyDeleteCollectiveArgs> = {
  argsSchema: PermanentlyDeleteCollectiveArgs,
  tool: {
    name: 'permanently_delete_collective',
    description:
      'Permanently delete a Collective from the trash. THIS IS IRREVERSIBLE. The Collective must already be in the trash (use delete_collective first). Set deleteTeam=true to also remove the underlying Nextcloud Team.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Collective id from list_trashed_collectives.' },
        deleteTeam: { type: 'boolean', description: 'Also delete the underlying Team (Circle). Default false.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Permanently delete Collective',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    await permanentlyDeleteCollective(ctx.client, args.id, args.deleteTeam);
    return textResult(`Collective ${args.id} permanently deleted. This cannot be undone.`);
  },
};

// -----------------------------------------------------------------------------
// Page tools
// -----------------------------------------------------------------------------

const ListPagesArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
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
    annotations: {
      title: 'List pages',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => jsonResult(await listPages(ctx.client, args.collectiveId)),
};

const GetPageArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
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
    annotations: {
      title: 'Read page',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const { page, markdown } = await getPage(ctx.client, args.collectiveId, args.pageId);
    // Server returns tag ids on the page; resolve to display names via the
    // per-collective tag list. An unknown id (newly created tag we haven't
    // refreshed) falls back to `#<id>` rather than vanishing.
    let tagLabels: string[] = [];
    if (page.tags.length > 0) {
      const allTags = await listTags(ctx.client, args.collectiveId);
      const idToName = new Map(allTags.map((t) => [t.id, t.name]));
      tagLabels = page.tags.map((id) => idToName.get(id) ?? `#${id}`);
    }
    const header = [
      `# ${page.emoji ? page.emoji + ' ' : ''}${page.title}`,
      '',
      `- id: ${page.id}`,
      `- parentId: ${page.parentId}`,
      `- path: ${page.collectivePath}/${page.filePath ? page.filePath + '/' : ''}${page.fileName}`,
      `- last edited: ${page.lastUserDisplayName} at ${new Date(page.timestamp * 1000).toISOString()}`,
      `- size: ${page.size} bytes`,
      tagLabels.length ? `- tags: ${tagLabels.join(', ')}` : '',
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
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const searchTool: ToolDef<typeof SearchArgs> = {
  argsSchema: SearchArgs,
  tool: {
    name: 'search',
    description:
      'Full-text search across all Collectives pages the user can access. Uses the Nextcloud unified search provider. For searching within a specific Collective, use search_in_collective instead.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term.' },
        limit: { type: 'integer', description: 'Maximum results to return (default 25).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Search all Collectives',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await searchPages(ctx.client, args.query, args.limit)),
};

const SearchInCollectiveArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    query: z.string().min(1),
  })
  .strict();

const searchInCollectiveTool: ToolDef<typeof SearchInCollectiveArgs> = {
  argsSchema: SearchInCollectiveArgs,
  tool: {
    name: 'search_in_collective',
    description:
      'Search for pages by content within a specific Collective. Returns matching page metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        query: { type: 'string', description: 'Search text.' },
      },
      required: ['collectiveId', 'query'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Search within Collective',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await searchPagesInCollective(ctx.client, args.collectiveId, args.query)),
};

// -----------------------------------------------------------------------------
// Page write tools
// -----------------------------------------------------------------------------

const CreatePageArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    parentPageId: z.coerce.number().int().positive(),
    title: z.string().min(1),
    body: z.string().optional(),
    emoji: z.string().optional(),
    templateId: z.coerce.number().int().positive().optional(),
  })
  .strict();

const createPageTool: ToolDef<typeof CreatePageArgs> = {
  argsSchema: CreatePageArgs,
  tool: {
    name: 'create_page',
    description:
      'Create a new page under a parent. If the parent is a leaf page, it is automatically promoted to a folder. Optionally initialise from a template.',
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
        templateId: { type: 'integer', description: 'Template page id to copy initial content from.' },
      },
      required: ['collectiveId', 'parentPageId', 'title'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Create page',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => jsonResult(await createPage(ctx.client, args)),
};

const UpdatePageArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
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
    annotations: {
      title: 'Write page content',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await updatePage(ctx.client, args.collectiveId, args.pageId, args.body, args.mode)),
};

const DeletePageArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
  })
  .strict();

const deletePageTool: ToolDef<typeof DeletePageArgs> = {
  argsSchema: DeletePageArgs,
  tool: {
    name: 'delete_page',
    description:
      'Trash a page (recoverable from the Collectives page trash). Folder pages take their entire subtree with them. The Landing page cannot be deleted — delete the collective itself instead.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
      },
      required: ['collectiveId', 'pageId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Trash page',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    await deletePage(ctx.client, args.collectiveId, args.pageId);
    return textResult(`Page ${args.pageId} moved to trash.`);
  },
};

const RenamePageArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
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
    annotations: {
      title: 'Rename page',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await renamePage(ctx.client, args.collectiveId, args.pageId, args.newTitle)),
};

const MovePageArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
    newParentPageId: z.coerce.number().int().positive(),
    index: z.coerce.number().int().nonnegative().optional(),
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
        index: { type: 'integer', description: "Position among the target parent's children (0 = first). Omit to use the server default." },
      },
      required: ['collectiveId', 'pageId', 'newParentPageId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Move page',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(
      await movePage(ctx.client, args.collectiveId, args.pageId, args.newParentPageId, args.index),
    ),
};

const SetPageEmojiArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
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
    annotations: {
      title: 'Set page emoji',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await setPageEmoji(ctx.client, args.collectiveId, args.pageId, args.emoji)),
};

const CopyPageArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
    newTitle: z.string().min(1).optional(),
    index: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

const copyPageTool: ToolDef<typeof CopyPageArgs> = {
  argsSchema: CopyPageArgs,
  tool: {
    name: 'copy_page',
    description:
      'Duplicate a page under the same parent. If newTitle is provided, the copy gets that title. Works for both leaf and folder pages.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        newTitle: { type: 'string', description: 'Title for the copy. If omitted, server assigns a default.' },
        index: { type: 'integer', description: "Position among the target parent's children (0 = first). Omit to use the server default." },
      },
      required: ['collectiveId', 'pageId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Copy page',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await copyPage(ctx.client, args.collectiveId, args.pageId, args.newTitle, args.index)),
};

const PageRefArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
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
    annotations: {
      title: 'Favorite page',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
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
    annotations: {
      title: 'Unfavorite page',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    await unfavoritePage(ctx.client, args.collectiveId, args.pageId);
    return textResult(`Page ${args.pageId} unfavorited.`);
  },
};

// -----------------------------------------------------------------------------
// Tag tools
// -----------------------------------------------------------------------------

const ListTagsArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
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
    annotations: {
      title: 'List tags',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => jsonResult(await listTags(ctx.client, args.collectiveId)),
};

const HexColor = z
  .string()
  .trim()
  .regex(
    /^#?[0-9a-fA-F]{6}$/,
    'color must be exactly six hexadecimal digits, optionally prefixed with "#" (e.g. "#2d7d46")',
  );

const CreateTagArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    name: z.string().min(1),
    color: HexColor,
  })
  .strict();

const createTagTool: ToolDef<typeof CreateTagArgs> = {
  argsSchema: CreateTagArgs,
  tool: {
    name: 'create_tag',
    description: 'Create a new tag in a Collective. Requires a name and a hex color code (e.g. "#FF0000").',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        name: { type: 'string', description: 'Tag name.' },
        color: {
          type: 'string',
          description: 'Six-digit hex color code, with or without "#" (e.g. "#FF0000" or "FF0000").',
        },
      },
      required: ['collectiveId', 'name', 'color'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Create tag',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await createTag(ctx.client, args.collectiveId, args.name, args.color)),
};

const UpdateTagArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    tagId: z.coerce.number().int().positive(),
    name: z.string().min(1),
    color: HexColor,
  })
  .strict();

const updateTagTool: ToolDef<typeof UpdateTagArgs> = {
  argsSchema: UpdateTagArgs,
  tool: {
    name: 'update_tag',
    description:
      'Update a tag. Both name and color are always applied, so pass the existing value for whichever one you are not changing — omitting a field is not supported by the API. Read current values with list_tags first.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        tagId: { type: 'integer', description: 'Tag id from list_tags.' },
        name: { type: 'string' },
        color: {
          type: 'string',
          description: 'Six-digit hex color code, with or without "#" (e.g. "#FF0000" or "FF0000").',
        },
      },
      required: ['collectiveId', 'tagId', 'name', 'color'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Update tag',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await updateTag(ctx.client, args.collectiveId, args.tagId, args.name, args.color)),
};

const DeleteTagArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    tagId: z.coerce.number().int().positive(),
  })
  .strict();

const deleteTagTool: ToolDef<typeof DeleteTagArgs> = {
  argsSchema: DeleteTagArgs,
  tool: {
    name: 'delete_tag',
    description: 'Delete a tag from a Collective.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        tagId: { type: 'integer' },
      },
      required: ['collectiveId', 'tagId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Delete tag',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    await deleteTag(ctx.client, args.collectiveId, args.tagId);
    return textResult(`Tag ${args.tagId} deleted.`);
  },
};

const SetPageTagsArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
    tagIds: z.array(z.coerce.number().int().nonnegative()),
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
    annotations: {
      title: 'Set page tags',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
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
    annotations: {
      title: 'List trashed pages',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
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
    annotations: {
      title: 'Restore page',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
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
    annotations: {
      title: 'Permanently delete page',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
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
    annotations: {
      title: 'List page versions',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await listPageVersions(ctx.client, args.collectiveId, args.pageId)),
};

const RestorePageVersionArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
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
    annotations: {
      title: 'Restore page version',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
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
    collectiveId: z.coerce.number().int().positive(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
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
    annotations: {
      title: 'List recent pages',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
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
    annotations: {
      title: 'List backlinks',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await getBacklinks(ctx.client, args.collectiveId, args.pageId)),
};

// -----------------------------------------------------------------------------
// Attachment tools
// -----------------------------------------------------------------------------

const listAttachmentsTool: ToolDef<typeof PageRefArgs> = {
  argsSchema: PageRefArgs,
  tool: {
    name: 'list_attachments',
    description:
      'List attachments for a page. Returns name, size, content type, and the relative markdown path to reference each file.',
    inputSchema: {
      type: 'object',
      properties: { collectiveId: { type: 'integer' }, pageId: { type: 'integer' } },
      required: ['collectiveId', 'pageId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'List attachments',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const attachments = await listAttachments(ctx.client, args.collectiveId, args.pageId);
    return jsonResult(attachments.map((a) => withRelativePath(a, args.pageId)));
  },
};

/** Strict base64: Node's decoder silently discards anything it cannot parse. */
function decodeBase64Strict(content: string): Buffer {
  const compact = content.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error(
      'content is not valid base64. Pass encoding: "utf8" for text payloads, ' +
        'or supply properly padded base64 for binary ones.',
    );
  }
  return Buffer.from(compact, 'base64');
}

const UploadAttachmentArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
    filename: z.string().min(1),
    content: z.string(),
    encoding: z.enum(['utf8', 'base64']).optional(),
    contentType: z.string().optional(),
  })
  .strict();

const uploadAttachmentTool: ToolDef<typeof UploadAttachmentArgs> = {
  argsSchema: UploadAttachmentArgs,
  tool: {
    name: 'upload_attachment',
    description:
      'Upload an attachment to a page. Creates the attachment directory if needed. Returns a percent-encoded `relativePath` ready to paste into markdown (e.g. `![alt](.attachments.{pageId}/filename.png)`).',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        filename: { type: 'string', description: 'Filename for the attachment.' },
        content: {
          type: 'string',
          description: 'File content, interpreted according to `encoding`.',
        },
        encoding: {
          type: 'string',
          enum: ['utf8', 'base64'],
          description:
            'How `content` is encoded. Set this explicitly for binary files. ' +
            'If omitted it is inferred from contentType: textual types (text/*, application/json, ' +
            'image/svg+xml, */*+json, */*+xml) are read as utf8, everything else as base64. ' +
            'A missing contentType is treated as utf8.',
        },
        contentType: { type: 'string', description: 'MIME type (e.g. "image/png", "text/plain"). Defaults to application/octet-stream.' },
      },
      required: ['collectiveId', 'pageId', 'filename', 'content'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Upload attachment',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const encoding =
      args.encoding ??
      (!args.contentType || isTextualMimeType(args.contentType) ? 'utf8' : 'base64');
    const content = encoding === 'utf8' ? args.content : decodeBase64Strict(args.content);
    const result = await uploadAttachment(
      ctx.client,
      args.collectiveId,
      args.pageId,
      args.filename,
      content,
      args.contentType,
    );
    return jsonResult(withRelativePath(result, args.pageId));
  },
};

const DeleteAttachmentArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
    filename: z.string().min(1),
  })
  .strict();

const deleteAttachmentTool: ToolDef<typeof DeleteAttachmentArgs> = {
  argsSchema: DeleteAttachmentArgs,
  tool: {
    name: 'delete_attachment',
    description:
      'Delete an attachment from a page. Returns the deleted attachment including its id, which restore_attachment needs to undo this.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        filename: { type: 'string', description: 'Attachment filename to delete.' },
      },
      required: ['collectiveId', 'pageId', 'filename'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Delete attachment',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const attachment = await deleteAttachment(
      ctx.client,
      args.collectiveId,
      args.pageId,
      args.filename,
    );
    return jsonResult({
      deleted: attachment,
      note: `Restore with restore_attachment using attachmentId ${attachment.id}.`,
    });
  },
};

// -----------------------------------------------------------------------------
// Template tools
// -----------------------------------------------------------------------------

const ListTemplatesArgs = z
  .object({ collectiveId: z.coerce.number().int().positive() })
  .strict();

const listTemplatesTool: ToolDef<typeof ListTemplatesArgs> = {
  argsSchema: ListTemplatesArgs,
  tool: {
    name: 'list_templates',
    description: 'List page templates defined for a Collective.',
    inputSchema: {
      type: 'object',
      properties: { collectiveId: { type: 'integer' } },
      required: ['collectiveId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'List templates',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => jsonResult(await listTemplates(ctx.client, args.collectiveId)),
};

const CreateTemplateArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    title: z.string().min(1),
    parentId: z.coerce.number().int().positive(),
  })
  .strict();

const createTemplateTool: ToolDef<typeof CreateTemplateArgs> = {
  argsSchema: CreateTemplateArgs,
  tool: {
    name: 'create_template',
    description: 'Create a page template in a Collective.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        title: { type: 'string' },
        parentId: { type: 'integer', description: 'Parent page id for template hierarchy.' },
      },
      required: ['collectiveId', 'title', 'parentId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Create template',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await createTemplate(ctx.client, args.collectiveId, args.title, args.parentId)),
};

const UpdateTemplateArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    templateId: z.coerce.number().int().positive(),
    title: z.string().min(1),
  })
  .strict();

const updateTemplateTool: ToolDef<typeof UpdateTemplateArgs> = {
  argsSchema: UpdateTemplateArgs,
  tool: {
    name: 'update_template',
    description: 'Rename a page template.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        templateId: { type: 'integer' },
        title: { type: 'string' },
      },
      required: ['collectiveId', 'templateId', 'title'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Rename template',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await updateTemplate(ctx.client, args.collectiveId, args.templateId, args.title)),
};

const SetTemplateEmojiArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    templateId: z.coerce.number().int().positive(),
    emoji: z.string(),
  })
  .strict();

const setTemplateEmojiTool: ToolDef<typeof SetTemplateEmojiArgs> = {
  argsSchema: SetTemplateEmojiArgs,
  tool: {
    name: 'set_template_emoji',
    description: 'Set or clear the emoji icon on a page template.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        templateId: { type: 'integer' },
        emoji: { type: 'string', description: 'A single emoji, or "" to clear.' },
      },
      required: ['collectiveId', 'templateId', 'emoji'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Set template emoji',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await setTemplateEmoji(ctx.client, args.collectiveId, args.templateId, args.emoji)),
};

const DeleteTemplateArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    templateId: z.coerce.number().int().positive(),
  })
  .strict();

const deleteTemplateTool: ToolDef<typeof DeleteTemplateArgs> = {
  argsSchema: DeleteTemplateArgs,
  tool: {
    name: 'delete_template',
    description: 'Delete a page template.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        templateId: { type: 'integer' },
      },
      required: ['collectiveId', 'templateId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Delete template',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    await deleteTemplate(ctx.client, args.collectiveId, args.templateId);
    return textResult(`Template ${args.templateId} deleted.`);
  },
};

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Page layout, ordering, and touch
// -----------------------------------------------------------------------------

const SetPageFullWidthArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
    fullWidth: z.coerce.boolean(),
  })
  .strict();

const setPageFullWidthTool: ToolDef<typeof SetPageFullWidthArgs> = {
  argsSchema: SetPageFullWidthArgs,
  tool: {
    name: 'set_page_full_width',
    description:
      'Toggle a page\'s full-width layout. This is a Collective-wide display property of the page, not a per-user preference.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        fullWidth: { type: 'boolean', description: 'true for full width, false for the default column width.' },
      },
      required: ['collectiveId', 'pageId', 'fullWidth'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Set page width',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await setPageFullWidth(ctx.client, args.collectiveId, args.pageId, args.fullWidth)),
};

const SetSubpageOrderArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
    subpageOrder: z.array(z.coerce.number().int().positive()),
  })
  .strict();

const setSubpageOrderTool: ToolDef<typeof SetSubpageOrderArgs> = {
  argsSchema: SetSubpageOrderArgs,
  tool: {
    name: 'set_subpage_order',
    description:
      'Set the explicit left-to-right ordering of a page\'s immediate child pages. Every id must be a direct child of the page; duplicates are rejected. Pass an empty array to clear the manual order and fall back to the Collective sort. Only takes effect for users whose page order is set to "byOrder".',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer', description: 'The parent page whose children are being ordered.' },
        subpageOrder: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Child page ids in the desired order. Empty array clears the manual order.',
        },
      },
      required: ['collectiveId', 'pageId', 'subpageOrder'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Set subpage order',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await setSubpageOrder(ctx.client, args.collectiveId, args.pageId, args.subpageOrder)),
};

const touchPageTool: ToolDef<typeof PageRefArgs> = {
  argsSchema: PageRefArgs,
  tool: {
    name: 'touch_page',
    description:
      'Bump a page\'s modification timestamp and record the authenticated user as its last editor, without changing content. Useful for marking a page as reviewed.',
    inputSchema: {
      type: 'object',
      properties: { collectiveId: { type: 'integer' }, pageId: { type: 'integer' } },
      required: ['collectiveId', 'pageId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Touch page',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await touchPage(ctx.client, args.collectiveId, args.pageId)),
};

// -----------------------------------------------------------------------------
// Cross-Collective move / copy
// -----------------------------------------------------------------------------

const MovePageToCollectiveArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
    newCollectiveId: z.coerce.number().int().positive(),
    parentId: z.coerce.number().int().nonnegative().optional(),
    index: z.coerce.number().int().nonnegative().optional(),
    copy: z.coerce.boolean().optional(),
  })
  .strict();

const movePageToCollectiveTool: ToolDef<typeof MovePageToCollectiveArgs> = {
  argsSchema: MovePageToCollectiveArgs,
  tool: {
    name: 'move_page_to_collective',
    description:
      'Move or copy a page (with its subpages and attachments) into a different Collective. Set copy: true to duplicate instead of moving. The page id changes on arrival, so use the returned page for follow-up calls. For reorganising within one Collective use move_page or copy_page instead.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer', description: 'Source Collective id.' },
        pageId: { type: 'integer', description: 'Page to move or copy.' },
        newCollectiveId: { type: 'integer', description: 'Destination Collective id.' },
        parentId: {
          type: 'integer',
          description: 'Target parent page in the destination Collective. Omit to place it at the root.',
        },
        index: { type: 'integer', description: 'Position among the target parent children (0 = first).' },
        copy: { type: 'boolean', description: 'Copy instead of moving. Defaults to false (move).' },
      },
      required: ['collectiveId', 'pageId', 'newCollectiveId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Move page to another Collective',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(
      await movePageToCollective(ctx.client, args.collectiveId, args.pageId, args.newCollectiveId, {
        parentId: args.parentId,
        index: args.index,
        copy: args.copy,
      }),
    ),
};

// -----------------------------------------------------------------------------
// Public shares
// -----------------------------------------------------------------------------

/**
 * Strip the password the API echoes back on share create/update. Callers never
 * need it, and a share password must not leak into transcripts or logs. The
 * boolean is enough to tell whether a share is password-protected.
 */
function redactShare(share: CollectiveShare): Omit<CollectiveShare, 'password'> & {
  hasPassword: boolean;
  scope: 'collective' | 'page';
} {
  const { password, ...rest } = share;
  return { ...rest, hasPassword: Boolean(password), scope: share.pageId ? 'page' : 'collective' };
}

const ListSharesArgs = z
  .object({ collectiveId: z.coerce.number().int().positive() })
  .strict();

const listSharesTool: ToolDef<typeof ListSharesArgs> = {
  argsSchema: ListSharesArgs,
  tool: {
    name: 'list_shares',
    description:
      'List all public share links on a Collective, including per-page shares. Each entry reports its scope ("collective" or "page"), token, whether visitors can edit, and whether a password is set. Passwords themselves are never returned.',
    inputSchema: {
      type: 'object',
      properties: { collectiveId: { type: 'integer' } },
      required: ['collectiveId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'List shares',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult((await listShares(ctx.client, args.collectiveId)).map(redactShare)),
};

const CreateCollectiveShareArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    password: z.string().min(1).optional(),
  })
  .strict();

const createCollectiveShareTool: ToolDef<typeof CreateCollectiveShareArgs> = {
  argsSchema: CreateCollectiveShareArgs,
  tool: {
    name: 'create_collective_share',
    description:
      'Create a public share link for an entire Collective. Anyone with the link can read it (and edit, if you later enable that with update_share). Returns the share token; build the URL as {nextcloud}/apps/collectives/p/{token}.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        password: {
          type: 'string',
          description: 'Optional password required to open the link. Never echoed back.',
        },
      },
      required: ['collectiveId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Create Collective share',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(redactShare(await createCollectiveShare(ctx.client, args.collectiveId, args.password))),
};

const CreatePageShareArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
    password: z.string().min(1).optional(),
  })
  .strict();

const createPageShareTool: ToolDef<typeof CreatePageShareArgs> = {
  argsSchema: CreatePageShareArgs,
  tool: {
    name: 'create_page_share',
    description:
      'Create a public share link for a single page rather than the whole Collective. Returns the share token; build the URL as {nextcloud}/apps/collectives/p/{token}.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        password: {
          type: 'string',
          description: 'Optional password required to open the link. Never echoed back.',
        },
      },
      required: ['collectiveId', 'pageId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Create page share',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(
      redactShare(await createPageShare(ctx.client, args.collectiveId, args.pageId, args.password)),
    ),
};

const UpdateShareArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    token: z.string().min(1),
    editable: z.coerce.boolean(),
    pageId: z.coerce.number().int().positive().optional(),
    password: z.string().optional(),
  })
  .strict();

const updateShareTool: ToolDef<typeof UpdateShareArgs> = {
  argsSchema: UpdateShareArgs,
  tool: {
    name: 'update_share',
    description:
      'Update an existing share link. `editable` is required by the API and is always applied, so state it explicitly or you may silently change it. Pass pageId for a page share; omit it for the Collective-wide share. Pass an empty password to remove an existing one.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        token: { type: 'string', description: 'Share token from list_shares.' },
        editable: { type: 'boolean', description: 'Whether visitors may edit through the link.' },
        pageId: {
          type: 'integer',
          description: 'Required for a page share; omit for the Collective-wide share.',
        },
        password: {
          type: 'string',
          description: 'Set a new password, or "" to remove the existing one. Omit to leave unchanged.',
        },
      },
      required: ['collectiveId', 'token', 'editable'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Update share',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const patch = { editable: args.editable, password: args.password };
    const share = args.pageId
      ? await updatePageShare(ctx.client, args.collectiveId, args.pageId, args.token, patch)
      : await updateCollectiveShare(ctx.client, args.collectiveId, args.token, patch);
    return jsonResult(redactShare(share));
  },
};

const DeleteShareArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    token: z.string().min(1),
    pageId: z.coerce.number().int().positive().optional(),
  })
  .strict();

const deleteShareTool: ToolDef<typeof DeleteShareArgs> = {
  argsSchema: DeleteShareArgs,
  tool: {
    name: 'delete_share',
    description:
      'Revoke a public share link. The link stops working immediately for everyone holding it. Pass pageId for a page share; omit it for the Collective-wide share.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        token: { type: 'string', description: 'Share token from list_shares.' },
        pageId: {
          type: 'integer',
          description: 'Required for a page share; omit for the Collective-wide share.',
        },
      },
      required: ['collectiveId', 'token'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Revoke share',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    if (args.pageId) {
      await deletePageShare(ctx.client, args.collectiveId, args.pageId, args.token);
    } else {
      await deleteCollectiveShare(ctx.client, args.collectiveId, args.token);
    }
    return textResult(`Share ${args.token} revoked.`);
  },
};

// -----------------------------------------------------------------------------
// Collective and user display settings
// -----------------------------------------------------------------------------

const SetPageModeArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    mode: z.enum(['view', 'edit']),
  })
  .strict();

const setPageModeTool: ToolDef<typeof SetPageModeArgs> = {
  argsSchema: SetPageModeArgs,
  tool: {
    name: 'set_page_mode',
    description:
      'Set the default page mode for a Collective — whether pages open in view or edit mode. This applies to every member of the Collective, unlike set_user_settings which is per-user.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        mode: { type: 'string', enum: ['view', 'edit'], description: 'Default mode pages open in.' },
      },
      required: ['collectiveId', 'mode'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Set Collective page mode',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => jsonResult(await setPageMode(ctx.client, args.collectiveId, args.mode)),
};

const SetUserSettingsArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageOrder: z.enum(['byOrder', 'byTimeAsc', 'byTitleAsc', 'byTimeDesc', 'byTitleDesc']).optional(),
    showMembers: z.coerce.boolean().optional(),
    showRecentPages: z.coerce.boolean().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.pageOrder !== undefined || v.showMembers !== undefined || v.showRecentPages !== undefined,
    { message: 'Provide at least one of pageOrder, showMembers, or showRecentPages.' },
  );

const setUserSettingsTool: ToolDef<typeof SetUserSettingsArgs> = {
  argsSchema: SetUserSettingsArgs,
  tool: {
    name: 'set_user_settings',
    description:
      'Update the authenticated user\'s own display preferences for one Collective: page sort order, and whether the members and recent-pages widgets on the landing page are expanded. These are per-user and do not affect other members — use set_page_mode for the Collective-wide setting. Provide at least one field; omitted fields are left unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageOrder: {
          type: 'string',
          enum: ['byOrder', 'byTimeAsc', 'byTitleAsc', 'byTimeDesc', 'byTitleDesc'],
          description: 'Page sort order. "byOrder" honours the manual order set by set_subpage_order.',
        },
        showMembers: { type: 'boolean', description: 'Expand the members widget on the landing page.' },
        showRecentPages: {
          type: 'boolean',
          description: 'Expand the recent-pages widget on the landing page.',
        },
      },
      required: ['collectiveId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Set user display settings',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const applied: string[] = [];
    if (args.pageOrder !== undefined) {
      await setUserPageOrder(ctx.client, args.collectiveId, args.pageOrder);
      applied.push(`pageOrder=${args.pageOrder}`);
    }
    if (args.showMembers !== undefined) {
      await setUserShowMembers(ctx.client, args.collectiveId, args.showMembers);
      applied.push(`showMembers=${args.showMembers}`);
    }
    if (args.showRecentPages !== undefined) {
      await setUserShowRecentPages(ctx.client, args.collectiveId, args.showRecentPages);
      applied.push(`showRecentPages=${args.showRecentPages}`);
    }
    return textResult(`Updated user settings for Collective ${args.collectiveId}: ${applied.join(', ')}.`);
  },
};

// -----------------------------------------------------------------------------
// Attachment download / rename / restore
// -----------------------------------------------------------------------------

const GetAttachmentArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
    filename: z.string().min(1),
    encoding: z.enum(['utf8', 'base64']).optional(),
  })
  .strict();

const getAttachmentTool: ToolDef<typeof GetAttachmentArgs> = {
  argsSchema: GetAttachmentArgs,
  tool: {
    name: 'get_attachment',
    description:
      'Download an attachment\'s contents. Returns the bytes as utf8 text or a base64 string, with the encoding stated in the result. Refuses files over 5 MB, which should be fetched from Nextcloud directly.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        filename: { type: 'string', description: 'Attachment filename from list_attachments.' },
        encoding: {
          type: 'string',
          enum: ['utf8', 'base64'],
          description:
            'How to return the content. If omitted it is inferred from the stored MIME type: textual types as utf8, everything else as base64.',
        },
      },
      required: ['collectiveId', 'pageId', 'filename'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Download attachment',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const result = await getAttachment(
      ctx.client,
      args.collectiveId,
      args.pageId,
      args.filename,
      args.encoding,
    );
    return jsonResult({
      ...result,
      attachment: withRelativePath(result.attachment, args.pageId),
    });
  },
};

const RenameAttachmentArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
    filename: z.string().min(1),
    newName: z.string().min(1),
  })
  .strict();

const renameAttachmentTool: ToolDef<typeof RenameAttachmentArgs> = {
  argsSchema: RenameAttachmentArgs,
  tool: {
    name: 'rename_attachment',
    description:
      'Rename an attachment on a page. Existing references to the old filename in page bodies are NOT rewritten — update them yourself, using the returned relativePath.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        filename: { type: 'string', description: 'Current attachment filename from list_attachments.' },
        newName: { type: 'string', description: 'New filename, including the extension.' },
      },
      required: ['collectiveId', 'pageId', 'filename', 'newName'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Rename attachment',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const attachment = await renameAttachment(
      ctx.client,
      args.collectiveId,
      args.pageId,
      args.filename,
      args.newName,
    );
    return jsonResult(withRelativePath(attachment, args.pageId));
  },
};

const RestoreAttachmentArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
    attachmentId: z.coerce.number().int().positive(),
  })
  .strict();

const restoreAttachmentTool: ToolDef<typeof RestoreAttachmentArgs> = {
  argsSchema: RestoreAttachmentArgs,
  tool: {
    name: 'restore_attachment',
    description:
      'Restore a deleted attachment from the page\'s attachment trash. Takes the numeric attachment id — a trashed attachment no longer appears in list_attachments, so there is no name to look up. delete_attachment returns the id you need.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        attachmentId: {
          type: 'integer',
          description: 'Attachment id, as returned by delete_attachment.',
        },
      },
      required: ['collectiveId', 'pageId', 'attachmentId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Restore attachment',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const attachment = await restoreAttachment(
      ctx.client,
      args.collectiveId,
      args.pageId,
      args.attachmentId,
    );
    return jsonResult(withRelativePath(attachment, args.pageId));
  },
};

// -----------------------------------------------------------------------------
// Template content
// -----------------------------------------------------------------------------

const TemplateRefArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    templateId: z.coerce.number().int().positive(),
  })
  .strict();

const getTemplateTool: ToolDef<typeof TemplateRefArgs> = {
  argsSchema: TemplateRefArgs,
  tool: {
    name: 'get_template',
    description:
      'Read a page template\'s metadata and markdown body. Use this to inspect what create_page(templateId) will produce.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        templateId: { type: 'integer', description: 'Template id from list_templates.' },
      },
      required: ['collectiveId', 'templateId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Read template',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const { template, markdown } = await getTemplate(ctx.client, args.collectiveId, args.templateId);
    return jsonResult({ template, markdown });
  },
};

const UpdateTemplateContentArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    templateId: z.coerce.number().int().positive(),
    body: z.string(),
    mode: z.enum(['replace', 'append', 'prepend']).default('replace'),
  })
  .strict();

const updateTemplateContentTool: ToolDef<typeof UpdateTemplateContentArgs> = {
  argsSchema: UpdateTemplateContentArgs,
  tool: {
    name: 'update_template_content',
    description:
      'Write a page template\'s markdown body. This is the content create_page(templateId) copies into new pages. An empty body is allowed and clears the template. Append and prepend are protected against concurrent edits and fail rather than overwriting someone else\'s change.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        templateId: { type: 'integer', description: 'Template id from list_templates.' },
        body: { type: 'string', description: 'Markdown content. Empty string clears the template.' },
        mode: {
          type: 'string',
          enum: ['replace', 'append', 'prepend'],
          description: 'How to apply body. Defaults to replace.',
        },
      },
      required: ['collectiveId', 'templateId', 'body'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Write template content',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(
      await updateTemplateContent(
        ctx.client,
        args.collectiveId,
        args.templateId,
        args.body,
        args.mode,
      ),
    ),
};

const REGISTRY = {
  ping,
  list_collectives: listCollectivesTool,
  create_collective: createCollectiveTool,
  update_collective: updateCollectiveTool,
  delete_collective: deleteCollectiveTool,
  list_trashed_collectives: listTrashedCollectivesTool,
  restore_trashed_collective: restoreTrashedCollectiveTool,
  permanently_delete_collective: permanentlyDeleteCollectiveTool,
  list_pages: listPagesTool,
  get_page: getPageTool,
  search: searchTool,
  search_in_collective: searchInCollectiveTool,
  create_page: createPageTool,
  update_page: updatePageTool,
  delete_page: deletePageTool,
  rename_page: renamePageTool,
  move_page: movePageTool,
  move_page_to_collective: movePageToCollectiveTool,
  set_page_emoji: setPageEmojiTool,
  copy_page: copyPageTool,
  set_page_full_width: setPageFullWidthTool,
  set_subpage_order: setSubpageOrderTool,
  touch_page: touchPageTool,
  favorite_page: favoritePageTool,
  unfavorite_page: unfavoritePageTool,
  list_tags: listTagsTool,
  create_tag: createTagTool,
  update_tag: updateTagTool,
  delete_tag: deleteTagTool,
  set_page_tags: setPageTagsTool,
  list_trashed_pages: listTrashedPagesTool,
  restore_page: restorePageTool,
  purge_page: purgePageTool,
  list_page_versions: listPageVersionsTool,
  restore_page_version: restorePageVersionTool,
  list_recent_pages: listRecentPagesTool,
  get_backlinks: getBacklinksTool,
  list_attachments: listAttachmentsTool,
  upload_attachment: uploadAttachmentTool,
  delete_attachment: deleteAttachmentTool,
  get_attachment: getAttachmentTool,
  rename_attachment: renameAttachmentTool,
  restore_attachment: restoreAttachmentTool,
  list_templates: listTemplatesTool,
  create_template: createTemplateTool,
  update_template: updateTemplateTool,
  set_template_emoji: setTemplateEmojiTool,
  delete_template: deleteTemplateTool,
  get_template: getTemplateTool,
  update_template_content: updateTemplateContentTool,
  list_shares: listSharesTool,
  create_collective_share: createCollectiveShareTool,
  create_page_share: createPageShareTool,
  update_share: updateShareTool,
  delete_share: deleteShareTool,
  set_page_mode: setPageModeTool,
  set_user_settings: setUserSettingsTool,
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
