# collectives-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Nextcloud Collectives](https://github.com/nextcloud/collectives) — exposes collectives, pages, tags, attachments, page history, and trash to Claude and any MCP-compatible client.

## How it works

Collectives doesn't ship a single clean REST API for everything an MCP needs, so this server is a thin hybrid of two Nextcloud APIs:

| Layer | Used for |
| --- | --- |
| OCS API (`/ocs/v2.php/apps/collectives/api/v1.0/...`) | Metadata: collectives, page tree, tags, emoji, trash, recents, page reordering |
| WebDAV (`/remote.php/dav/files/{user}/.Collectives/...`) | Content read/write, create/delete/move pages, attachments, version history |

WebDAV is the escape hatch for any operation where the OCS API is quirky or incomplete.

## Tools exposed

- **Collectives:** `list_collectives`, `create_collective`, `update_collective`, `delete_collective`
- **Pages:** `list_pages`, `get_page`, `create_page`, `update_page`, `delete_page`, `rename_page`, `move_page`, `copy_page`, `set_page_emoji`, `set_page_tags`, `list_tags`, `favorite_page`, `unfavorite_page`
- **Trash & history:** `list_trashed_pages`, `restore_page`, `purge_page`, `list_page_versions`, `restore_page_version`, `list_recent_pages`
- **Search & attachments:** `search`, `list_attachments`, `upload_attachment`, `delete_attachment`

## Install

Download `collectives-mcp-0.1.0.tgz` from the [latest release](https://github.com/megamaced/nc_collectives-mcp/releases/latest), then:

```bash
npm install -g ./collectives-mcp-0.1.0.tgz
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
