#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config.js';
import { NextcloudClient } from './http.js';

const config = loadConfig();
const client = new NextcloudClient(config);

const tools: Tool[] = [
  {
    name: 'ping',
    description:
      'Verify connectivity to the configured Nextcloud instance. ' +
      'Calls the Collectives OCS API and reports how many collectives are visible to the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: 'collectives-mcp', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  switch (req.params.name) {
    case 'ping': {
      const data = await client.ocs<{ collectives: unknown[] }>('GET', '/collectives');
      const count = data.collectives?.length ?? 0;
      return {
        content: [
          {
            type: 'text',
            text: `OK — connected to ${config.url} as ${config.user}; ${count} collective(s) visible.`,
          },
        ],
      };
    }
    default:
      throw new Error(`Unknown tool: ${req.params.name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
