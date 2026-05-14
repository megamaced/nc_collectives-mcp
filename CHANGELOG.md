# Changelog

## v0.1.0 — Initial Release

First functional release of the Nextcloud Collectives MCP server.

### Features

- **29 tools** covering full CRUD lifecycle for Collectives, Pages, Tags, Attachments, Versions, and Trash
- **Collectives**: list, create, update (name/emoji/permissions), delete
- **Pages**: list, get (with markdown body), create, update (replace/append/prepend), delete, rename, move, copy, set emoji, favorite/unfavorite
- **Search**: full-text search via Nextcloud unified search provider
- **Tags**: list collective tags, add/remove/set tags on pages
- **Attachments**: list, upload (text and binary with base64 decoding), delete
- **Versions**: list page version history, restore a specific version
- **Trash**: list trashed pages, restore, permanent purge
- **Recent pages**: list recently modified pages (sorted client-side)
- **Backlinks**: find pages that link to a given page

### Reliability

- Automatic retry with exponential backoff on 429 (rate-limited) and 5xx responses
- Respects `Retry-After` header from Nextcloud
- Structured error responses with actionable hints (expired credentials, missing permissions, etc.)
- Debug logging to stderr when `DEBUG=1` is set

### Developer Experience

- TypeScript strict mode with `noUncheckedIndexedAccess`
- Zod schema validation on all tool inputs
- ESLint with flat config
- GitHub Actions CI: lint, typecheck, build on push and pull request
