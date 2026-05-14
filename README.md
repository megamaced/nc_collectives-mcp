# collectives-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Nextcloud Collectives](https://github.com/nextcloud/collectives) — exposes collectives, pages, tags, attachments, page history, and trash to Claude and any MCP-compatible client.

## How it works

The server uses two Nextcloud APIs, verified against the [Collectives OpenAPI spec](https://raw.githubusercontent.com/nextcloud/collectives/main/openapi.json):

| Layer | Used for |
| --- | --- |
| OCS API (`/ocs/v2.php/apps/collectives/api/v1.0/...`) | All CRUD operations: collectives, pages, tags, attachments, trash, templates, search, favorites |
| WebDAV (`/remote.php/dav/files/{user}/...`) | Page body read/write (no OCS equivalent), attachment upload, file version history |

The OCS API handles structured operations and returns typed JSON. WebDAV is used only where OCS has no equivalent — primarily reading and writing page markdown content.

## Tools exposed (41)

- **Collectives:** `list_collectives`, `create_collective`, `update_collective`, `delete_collective`
- **Collective trash:** `list_trashed_collectives`, `restore_trashed_collective`, `permanently_delete_collective`
- **Pages:** `list_pages`, `get_page`, `create_page`, `update_page`, `delete_page`, `rename_page`, `move_page`, `copy_page`, `set_page_emoji`, `set_page_tags`, `favorite_page`, `unfavorite_page`
- **Tags:** `list_tags`, `create_tag`, `update_tag`, `delete_tag`
- **Trash & history:** `list_trashed_pages`, `restore_page`, `purge_page`, `list_page_versions`, `restore_page_version`, `list_recent_pages`
- **Templates:** `list_templates`, `create_template`, `update_template`, `set_template_emoji`, `delete_template`
- **Search:** `search`, `search_in_collective`
- **Attachments:** `list_attachments`, `upload_attachment`, `delete_attachment`
- **Other:** `ping`, `get_backlinks`

## Install

Download `collectives-mcp-0.2.0.tgz` from the [latest release](https://github.com/megamaced/nc_collectives-mcp/releases/latest), then:

```bash
npm install -g ./collectives-mcp-0.2.0.tgz
```

This installs the `collectives-mcp` command globally.

## Configuration

Add to your MCP client config (Claude Code shown):

```json
{
  "mcpServers": {
    "collectives": {
      "command": "collectives-mcp",
      "args": [],
      "env": {
        "NEXTCLOUD_URL": "https://your-nextcloud.example.com",
        "NEXTCLOUD_USER": "your-username",
        "NEXTCLOUD_APP_PASSWORD": "xxxx-xxxx-xxxx-xxxx-xxxx"
      }
    }
  }
}
```

**Generate the app-password** in Nextcloud under Settings > Security > Devices & sessions > "Create new app password". The MCP server only needs an app-password, never your real account password — and you can revoke it without affecting your main login.

## Development

```bash
pnpm install
pnpm dev      # stdio MCP server, point mcp inspector at it
pnpm test     # integration tests against MCP_TEST_COLLECTIVE
pnpm build    # tsc -> dist/
```

Required env vars: `NEXTCLOUD_URL`, `NEXTCLOUD_USER`, `NEXTCLOUD_APP_PASSWORD`. Tests additionally need `MCP_TEST_COLLECTIVE` pointing at a throwaway collective.

## License

MIT — see [LICENSE](LICENSE).

## Related

- [Nextcloud Collectives](https://github.com/nextcloud/collectives)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
