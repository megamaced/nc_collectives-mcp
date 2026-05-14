import { z, type ZodTypeAny } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  copyPage,
  createCollective,
  createPage,
  createTag,
  createTemplate,
  deleteAttachment,
  deleteCollective,
  deletePage,
  deleteTag,
  deleteTemplate,
  favoritePage,
  getBacklinks,
  getPage,
  listAttachments,
  listCollectives,
  listPages,
  listPageVersions,
  listRecentPages,
  listTags,
  listTemplates,
  listTrashedCollectives,
  listTrashedPages,
  movePage,
  permanentlyDeleteCollective,
  purgePage,
  renamePage,
  restorePage,
  restorePageVersion,
  restoreTrashedCollective,
  searchPages,
  searchPagesInCollective,
  setPageEmoji,
  setPageTags,
  setTemplateEmoji,
  unfavoritePage,
  updateCollective,
  updatePage,
  updateTag,
  updateTemplate,
  uploadAttachment,
} from './api.js';
import { HttpError, OcsError, type NextcloudClient } from './http.js';
import type { PageAttachment } from './types.js';

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

/** Add a markdown-reference `relativePath` to each attachment for convenience. */
function withRelativePath(att: PageAttachment, pageId: number): PageAttachment & { relativePath: string } {
  return { ...att, relativePath: `.attachments.${pageId}/${att.name}` };
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
  },
  handler: async (args, ctx) =>
    jsonResult(await renamePage(ctx.client, args.collectiveId, args.pageId, args.newTitle)),
};

const MovePageArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
    newParentPageId: z.coerce.number().int().positive(),
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
  },
  handler: async (args, ctx) =>
    jsonResult(await setPageEmoji(ctx.client, args.collectiveId, args.pageId, args.emoji)),
};

const CopyPageArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
    newTitle: z.string().min(1).optional(),
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
  },
  handler: async (args, ctx) => jsonResult(await listTags(ctx.client, args.collectiveId)),
};

const CreateTagArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    name: z.string().min(1),
    color: z.string().min(1),
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
        color: { type: 'string', description: 'Hex color code, e.g. "#FF0000".' },
      },
      required: ['collectiveId', 'name', 'color'],
      additionalProperties: false,
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
    color: z.string().min(1),
  })
  .strict();

const updateTagTool: ToolDef<typeof UpdateTagArgs> = {
  argsSchema: UpdateTagArgs,
  tool: {
    name: 'update_tag',
    description: 'Update a tag\'s name and color.',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        tagId: { type: 'integer', description: 'Tag id from list_tags.' },
        name: { type: 'string' },
        color: { type: 'string', description: 'Hex color code.' },
      },
      required: ['collectiveId', 'tagId', 'name', 'color'],
      additionalProperties: false,
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
  },
  handler: async (args, ctx) => {
    const attachments = await listAttachments(ctx.client, args.collectiveId, args.pageId);
    return jsonResult(attachments.map((a) => withRelativePath(a, args.pageId)));
  },
};

const UploadAttachmentArgs = z
  .object({
    collectiveId: z.coerce.number().int().positive(),
    pageId: z.coerce.number().int().positive(),
    filename: z.string().min(1),
    content: z.string(),
    contentType: z.string().optional(),
  })
  .strict();

const uploadAttachmentTool: ToolDef<typeof UploadAttachmentArgs> = {
  argsSchema: UploadAttachmentArgs,
  tool: {
    name: 'upload_attachment',
    description:
      'Upload an attachment to a page. Creates the attachment directory if needed. Returns the relative path to use in markdown (e.g. `![alt](.attachments.{pageId}/filename.png)`).',
    inputSchema: {
      type: 'object',
      properties: {
        collectiveId: { type: 'integer' },
        pageId: { type: 'integer' },
        filename: { type: 'string', description: 'Filename for the attachment.' },
        content: {
          type: 'string',
          description: 'File content as a UTF-8 string (for text) or base64-encoded string (for binary; set contentType accordingly).',
        },
        contentType: { type: 'string', description: 'MIME type (e.g. "image/png", "text/plain"). Defaults to application/octet-stream.' },
      },
      required: ['collectiveId', 'pageId', 'filename', 'content'],
      additionalProperties: false,
    },
  },
  handler: async (args, ctx) => {
    const isText = !args.contentType || args.contentType.startsWith('text/');
    const content = isText ? args.content : Buffer.from(args.content, 'base64');
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
    description: 'Delete an attachment from a page.',
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
  },
  handler: async (args, ctx) => {
    await deleteAttachment(ctx.client, args.collectiveId, args.pageId, args.filename);
    return textResult(`Attachment "${args.filename}" deleted from page ${args.pageId}.`);
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
  },
  handler: async (args, ctx) => {
    await deleteTemplate(ctx.client, args.collectiveId, args.templateId);
    return textResult(`Template ${args.templateId} deleted.`);
  },
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
  set_page_emoji: setPageEmojiTool,
  copy_page: copyPageTool,
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
  list_templates: listTemplatesTool,
  create_template: createTemplateTool,
  update_template: updateTemplateTool,
  set_template_emoji: setTemplateEmojiTool,
  delete_template: deleteTemplateTool,
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
