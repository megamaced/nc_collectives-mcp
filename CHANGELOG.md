# Changelog

## v0.2.2 — Page tag type fix

The `Page.tags` field is a list of numeric tag ids, not names — the server returns `[1, 3]`, not `["Bird", "Riparian"]`. Because TypeScript types are erased at runtime and there is no runtime schema for the page DTO, this misuse didn't throw but silently corrupted two tag-related code paths.

### Bug Fixes

- **`Page.tags` typed correctly** as `number[]` in `types.ts` so future consumers don't repeat the mistake
- **`get_page`**: tag line now displays the tag *names* (resolved via `listTags`) instead of the raw numeric ids that `Array.prototype.join` was coercing to strings. Unknown ids fall back to `#<id>` rather than being silently dropped
- **`set_page_tags`**: tag removal was broken — the diff fed each tag id through a name→id map (so `currentTagIds` was always empty), which meant removals were never issued and adds were spuriously re-issued for tags already on the page. Now diffs id-to-id directly

---

## v0.2.1 — Live Testing Fixes

Fixes found during live testing against Nextcloud Collectives 4.4.0 on a real server. All endpoints now verified against the [raw OpenAPI spec](https://raw.githubusercontent.com/nextcloud/collectives/main/openapi.json) endpoint listing.

### Bug Fixes

- **update_collective**: emoji uses `PUT /collectives/{id}` with emoji in body (not a `/emoji` sub-path); removed `name` field (no rename endpoint exists in the spec)
- **search_in_collective**: path corrected to `GET /collectives/{id}/search` (was `/pages/search`)
- **templates**: all endpoints corrected to `/pages/templates` prefix (was `/templates`)
- **create_tag / update_tag**: strip `#` prefix from hex colour codes — the DB column is `varchar(6)`, so `#2d7d46` overflows but `2d7d46` works
- **attachments relativePath**: pass `pageId` from caller context — the OCS response does not include a `pageId` field
- **Zod schemas**: use `z.coerce.number()` for all integer args to handle string-to-number coercion from MCP client serialization

---

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
