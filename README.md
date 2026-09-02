# collectives-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Nextcloud Collectives](https://github.com/nextcloud/collectives) — exposes collectives, pages, tags, attachments, templates, public shares, page history, and trash to Claude and any MCP-compatible client.

## How it works

The server uses two Nextcloud APIs, verified against the [Collectives OpenAPI spec](https://raw.githubusercontent.com/nextcloud/collectives/main/openapi.json):

| Layer | Used for |
| --- | --- |
| OCS API (`/ocs/v2.php/apps/collectives/api/v1.0/...`) | All structured operations: collectives, pages, tags, attachments, shares, settings, trash, templates, search, favorites |
| WebDAV (`/remote.php/dav/files/{user}/...`) | Page and template body read/write (no OCS equivalent), attachment upload/download, file version history |

The OCS API handles structured operations and returns typed JSON. WebDAV is used only where OCS has no equivalent — primarily reading and writing page markdown content.

## Tools exposed (57)

- **Collectives:** `list_collectives`, `create_collective`, `update_collective`, `delete_collective`, `set_page_mode`, `set_user_settings`
- **Collective trash:** `list_trashed_collectives`, `restore_trashed_collective`, `permanently_delete_collective`
- **Pages:** `list_pages`, `get_page`, `create_page`, `update_page`, `delete_page`, `rename_page`, `move_page`, `move_page_to_collective`, `copy_page`, `set_page_emoji`, `set_page_tags`, `favorite_page`, `unfavorite_page`
- **Page layout & ordering:** `set_page_full_width`, `set_subpage_order`, `touch_page`
- **Tags:** `list_tags`, `create_tag`, `update_tag`, `delete_tag`
- **Trash & history:** `list_trashed_pages`, `restore_page`, `purge_page`, `list_page_versions`, `restore_page_version`, `list_recent_pages`
- **Templates:** `list_templates`, `create_template`, `update_template`, `get_template`, `update_template_content`, `set_template_emoji`, `delete_template`
- **Search:** `search`, `search_in_collective`
- **Attachments:** `list_attachments`, `get_attachment`, `upload_attachment`, `rename_attachment`, `delete_attachment`, `restore_attachment`
- **Public shares:** `list_shares`, `create_collective_share`, `create_page_share`, `update_share`, `delete_share`
- **Other:** `ping`, `get_backlinks`

Every tool declares MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so clients can distinguish a read from an irreversible delete without parsing descriptions.

## Install

Download the `collectives-mcp-<version>.tgz` asset from the [latest release](https://github.com/megamaced/nc_collectives-mcp/releases/latest), then:

```bash
npm install -g ./collectives-mcp-<version>.tgz
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
pnpm test     # unit tests, plus integration tests when MCP_TEST_COLLECTIVE_ID is set
pnpm build    # tsc -> dist/
```

Required env vars: `NEXTCLOUD_URL`, `NEXTCLOUD_USER`, `NEXTCLOUD_APP_PASSWORD`. Optional: `NEXTCLOUD_TIMEOUT_MS` (per-request deadline, default 60000).

The integration tests additionally need `MCP_TEST_COLLECTIVE_ID` set to the numeric id of a throwaway collective. Without it they skip; the deterministic unit tests still run.

## Disclosure

This project was 100% written by AI (Claude), including all source code, tests, CI configuration, and documentation.

## License

MIT — see [LICENSE](LICENSE).

## Related

- [Nextcloud Collectives](https://github.com/nextcloud/collectives)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
