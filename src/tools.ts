import { z, type ZodTypeAny } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  createCollective,
  deleteCollective,
  getPage,
  listCollectives,
  listPages,
  searchPages,
  updateCollective,
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
