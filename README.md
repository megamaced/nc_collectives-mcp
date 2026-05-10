# collectives-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Nextcloud Collectives](https://github.com/nextcloud/collectives) — exposes collectives, pages, tags, attachments, page history, and trash to Claude and any MCP-compatible client.

Built to bring the same kind of Claude-driven docs workflow to Collectives that the Outline MCP provides for Outline.

> **Status:** in active development. See [Task List](https://macecloud.co.uk/apps/collectives/Wiki/Vibe%20Coding/Collectives%20MCP/Task%20List) for current progress and the [Requirements & Features](https://macecloud.co.uk/apps/collectives/Wiki/Vibe%20Coding/Collectives%20MCP) page for design decisions.

## How it works

Collectives doesn't ship a single clean REST API for everything we need, so this server is a thin hybrid:

| Layer | Used for |
| --- | --- |
| OCS API (`/ocs/v2.php/apps/collectives/api/v1.0/...`) | Metadata: collectives, page tree, tags, emoji, trash, recents, page reordering |
| WebDAV (`/remote.php/dav/files/{user}/.Collectives/...`) | Content read/write, create/delete/move pages, attachments, version history |

WebDAV is the escape hatch for any operation where the OCS API is quirky or incomplete.

## Tools exposed

Roughly grouped — the canonical list lives in the [requirements doc](https://macecloud.co.uk/apps/collectives/Wiki/Vibe%20Coding/Collectives%20MCP):

- **Collectives:** `list_collectives`, `create_collective`, `update_collective`, `delete_collective`
- **Pages:** `list_pages`, `get_page`, `create_page`, `update_page`, `delete_page`, `rename_page`, `move_page`, `copy_page`, `set_page_emoji`, `set_page_tags`, `list_tags`, `favorite_page`, `unfavorite_page`
- **Trash & history:** `list_trashed_pages`, `restore_page`, `purge_page`, `list_page_versions`, `restore_page_version`, `list_recent_pages`
- **Search & attachments:** `search`, `list_attachments`, `upload_attachment`, `delete_attachment`

## Install

> Not yet published. Once v0.1.0 ships, this section will cover `npx` and Gitea release tarball install.

## Configuration

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "collectives": {
      "command": "npx",
      "args": ["-y", "@macebox/collectives-mcp"],
      "env": {
        "NEXTCLOUD_URL": "https://your-nextcloud.example.com",
        "NEXTCLOUD_USER": "your-username",
        "NEXTCLOUD_APP_PASSWORD": "xxxx-xxxx-xxxx-xxxx-xxxx"
      }
    }
  }
}
```

**Generate the app-password** in Nextcloud under Settings → Security → Devices & sessions → "Create new app password". The MCP server only ever needs an app-password, never your real account password — and you can revoke it from the same screen without affecting your main login.

## Development

```bash
git clone https://gitea.macecloud.co.uk/macebox/collectives-mcp.git
cd collectives-mcp
pnpm install
pnpm dev      # stdio MCP server, point `mcp inspector` at it
pnpm test     # integration tests against MCP_TEST_COLLECTIVE
pnpm build    # tsc → dist/
```

Required env vars: `NEXTCLOUD_URL`, `NEXTCLOUD_USER`, `NEXTCLOUD_APP_PASSWORD`. Tests additionally need `MCP_TEST_COLLECTIVE` pointing at a throwaway collective.

## CI

Continuous integration runs on the Macebox [Woodpecker](https://ci.macecloud.co.uk) instance — see `.woodpecker.yml`. The pipeline runs lint, typecheck, build, and integration tests on every push to `main` and every pull request.

## Dependency updates

Renovate is configured via `renovate.json`. It opens PRs for dependency upgrades, grouped sensibly (dev-dependencies together, MCP SDK on its own track) and auto-merged for non-breaking patch versions once CI is green.

## License

MIT — see [LICENSE](LICENSE).

## Related

- [Nextcloud Collectives](https://github.com/nextcloud/collectives)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
