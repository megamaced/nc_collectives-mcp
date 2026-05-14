# Changelog

## v0.2.0 — API Audit & New Features

Full audit against the [Collectives OpenAPI spec](https://raw.githubusercontent.com/nextcloud/collectives/main/openapi.json), fixing incorrect HTTP methods, migrating page CRUD from WebDAV to OCS, and adding 12 new tools.

### Bug Fixes

- **restorePage**: fixed HTTP method (`PUT` → `PATCH`, spec-verified)
- **deleteCollective**: separated soft-delete from permanent-delete — the `circle` (delete team) parameter now correctly targets the trash endpoint only
- **getPage**: use dedicated `GET /pages/{id}` instead of fetching all pages and filtering
- **createPage**: switched from WebDAV `PUT` to OCS `POST /pages/{parentId}` — server now handles folder promotion and indexing atomically
- **renamePage / movePage / copyPage**: switched from WebDAV `MOVE`/`COPY` to OCS `PUT /pages/{id}` — supports folder pages, eliminates manual path math
- **listAttachments**: switched from WebDAV `PROPFIND` + XML parsing to OCS `GET /attachments`

### Security

- **Path traversal fix**: `versionId` in `restorePageVersion` is now URI-encoded
- **HTTPS warning**: log to stderr when `NEXTCLOUD_URL` uses `http://`
- **Error body truncation**: reduced from 500 to 200 characters to limit leakage of server internals

### New Tools (29 → 41)

- **Tag CRUD**: `create_tag`, `update_tag`, `delete_tag`
- **Collective trash**: `list_trashed_collectives`, `restore_trashed_collective`, `permanently_delete_collective`
- **Templates**: `list_templates`, `create_template`, `update_template`, `set_template_emoji`, `delete_template`
- **Scoped search**: `search_in_collective` — search within a specific collective via OCS

### Refactoring

- Extracted `fetchWithRetry()` — deduplicated identical retry loops across `ocs()`, `webdav()`, `webdavVersions()`
- Replaced `findPageOrThrow` (list-all + filter) with `getPageMeta` (single-page OCS endpoint)
- Added missing fields to `Collective` type (`userFavoritePages`, `pageMode`, etc.) — eliminates unsafe casts
- Moved shared types (`CollectiveTag`, `PageAttachment`, `PageVersion`) to `types.ts`

---

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
