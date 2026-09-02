# Changelog

## v0.4.0 — Shares, cross-Collective moves, and the rest of the v4.4 surface

Closes the feature backlog (#22–#27). The tool count goes from 41 to 57. Every operation was verified against the [v4.4.0 OpenAPI spec](https://github.com/nextcloud/collectives/blob/v4.4.0/openapi.json) before implementation, which turned up three places where `ENDPOINTS.md` was wrong — those are corrected too.

### Public shares (#22)

`list_shares`, `create_collective_share`, `create_page_share`, `update_share`, `delete_share`.

One `CollectiveShare` shape covers both kinds; `scope` in the result says which. **The API echoes share passwords back in its responses** — they are stripped before anything reaches the client, and replaced with a `hasPassword` boolean. `update_share` requires `editable` because the endpoint does: it is applied on every call, so leaving it implicit would silently flip it.

### Cross-Collective moves (#24)

`move_page_to_collective` moves or copies a page (with subpages and attachments) into another Collective, with optional destination parent and index.

The endpoint returns no page data and the page id changes in transit, so the result is located by diffing the destination Collective's page list rather than re-fetching an id that may now 404. Refuses a same-Collective call, pointing at `move_page`/`copy_page` instead, and checks both Collectives are accessible so a typo gives a clear message rather than a bare 404.

### Page layout and ordering (#23)

`set_page_full_width`, `set_subpage_order`, `touch_page`, plus an optional `index` on `move_page` and `copy_page`.

`set_subpage_order` validates the ids against the page's actual children and rejects duplicates before sending. The API takes a JSON-stringified array and accepts nonsense silently, so an unchecked typo would corrupt the stored order with no error.

### Attachment lifecycle (#25)

`get_attachment`, `rename_attachment`, `restore_attachment`.

Downloads state their encoding explicitly and are capped at 5 MB, since the bytes are returned inline through the MCP transport. Every by-name operation resolves the name against the page's real attachment list first, so no caller string is interpolated into a WebDAV path — the same discipline v0.3.0 applied to `delete_attachment`, now shared. `delete_attachment` returns the deleted attachment so its id can be passed to `restore_attachment`; a trashed attachment is absent from `list_attachments`, so there is no name left to resolve.

### Template content (#27)

`get_template` and `update_template_content`.

A template could be created and renamed but never authored, so `create_page(templateId)` could only copy content written through the web UI. Templates are pages on disk, so the write path is shared with `update_page` — including its `If-Match` concurrency handling.

### Collective and user settings (#26)

`set_page_mode` (Collective-wide) and `set_user_settings` (per-user page order and landing-page widgets). The split is deliberate and stated in both descriptions: one changes what every member sees, the other only the calling user.

### Fixes and maintenance

- **`update_tag`'s description did not mention that both `name` and `color` are always applied**, so a caller changing only the colour would blank the name. Found by a new registry test; the description now says to pass the existing value for the field you are not changing.
- **Dependabot configured** for npm and GitHub Actions. Dependency automation previously ran only against a now-retired Gitea mirror, which is why the SDK sat on 8 high-severity advisories until v0.3.0.
- **`ENDPOINTS.md` corrected** in three places the spec contradicted: share endpoints are *not* OCS-enveloped (create/update return the share directly, the list returns a bare array), `to/{newCollectiveId}` takes a `{parentId, index, copy}` body rather than none, and template creation requires `parentId` in the body. Also documents that `touch` is a GET that mutates.
- **12 more unit tests**, covering the setting enums, registry invariants (unique names, declared required properties, `additionalProperties: false`), and argument validation through `dispatchTool`.

---

## v0.3.0 — Reliability, path safety, and tool metadata

Resolves the open issue backlog (#1–#21): two path-traversal holes, a set of retry/timeout defects in the HTTP layer, several contract mismatches against the Collectives v4.4.0 OpenAPI spec, and the missing MCP tool annotations.

### Security

- **`delete_attachment` could escape the attachment directory** (#1). The filename was appended to the WebDAV path via `encodeURIComponent`, which leaves `.` and `..` intact; URL normalisation then resolved a name of `..` to the page folder or Collective root, so a DELETE could remove far more than the named file. The filename is now resolved against the page's real attachment list and deleted by id through OCS, so no caller-supplied string reaches a path builder.
- **`restore_page_version` had the same weakness** (#2). `versionId` is now matched against a strict pattern *and* checked for membership in `list_page_versions` before it is used as a path segment.

### Bug Fixes

- **`create_template` was unusable** (#3): the OCS body sent only `{title}`, but the v4.4.0 spec marks `parentId` required in the body as well as the path. Now sends both.
- **`create_page` ignored an explicitly empty body** (#4): a truthiness check meant `body: ""` skipped the WebDAV write, so an empty page could not be created and `templateId` + `body: ""` left the template content in place. Now tests `!== undefined`, and refreshes page metadata after the write.
- **`delete_page` was not idempotent** (#5): the metadata lookup sat outside the `try`, so a 404 for an already-deleted page threw instead of succeeding as documented.
- **Non-idempotent writes were retried after 5xx** (#6), which could duplicate a Collective, page, tag, template, attachment, or page copy when the server committed the write and then errored. 5xx is now replayed only for idempotent methods; 429 is still replayed for everything, since the server rejected the request outright. The page-copy endpoint is marked non-idempotent explicitly — it is a `PUT` that creates a new page each call.
- **No request timeouts, unbounded `Retry-After`** (#7): every request now carries an `AbortSignal.timeout` deadline (`NEXTCLOUD_TIMEOUT_MS`, default 60s) and reports a distinct `TimeoutError`. Retry delays, including server-supplied `Retry-After`, are capped at 30s.
- **Transient network failures were not retried** (#8): a `fetch` rejection from a connection reset or DNS blip escaped the retry loop entirely. Transient transport errors are now retried for idempotent requests; deadline aborts deliberately are not.
- **`Retry-After` waited twice** (#9): the loop slept for the header value and then slept again for exponential backoff on the next iteration. Each attempt now sleeps exactly once.
- **`upload_attachment` silently corrupted textual non-`text/*` files** (#10): the MIME heuristic treated `application/json` and `image/svg+xml` as base64, so raw content was decoded to garbage. Adds an explicit `encoding: "utf8" | "base64"` argument, corrects the inferred default to cover structured-text types, and validates base64 strictly instead of letting Node discard malformed input.
- **Attachment `relativePath` was not URL-encoded** (#11): names containing spaces, `#`, or `)` produced broken markdown links. Now uses the same encoder as the Collectives editor, which also escapes `!'()*`.
- **Tag colours were unvalidated** (#12): `red`, `#12345`, and `1234567` all reached the server, reproducing the `varchar(6)` overflow v0.2.1 set out to avoid. Both the Zod schema and the API boundary now require exactly six hex digits.
- **`append`/`prepend` overwrote concurrent edits** (#13): the read-modify-write had no precondition, so any edit landing between the GET and the PUT was lost silently. The ETag is now captured and sent as `If-Match`, with a bounded re-read-and-reapply on 412.
- **`NEXTCLOUD_URL` was not canonicalised** (#14): a query, fragment, or embedded credentials were accepted and then string-concatenated, putting the whole endpoint path inside a query string — or leaking a password through the `ping` summary. All three are now rejected, and a deployment sub-path is preserved.
- **Server reported a stale version** (#15): `0.2.1` was hard-coded while the package was `0.2.2`. Now read from `package.json`, with a test asserting they match.
- **30 production dependency advisories** (#16, 8 high / 20 moderate / 2 low), all transitive through `@modelcontextprotocol/sdk@1.29.0`. Updated to 1.30.0; `pnpm audit --prod` is now clean and runs in CI.

### Maintenance

- **Removed the dead `sanitizeTitle` API and its orphaned tests** (#17). Page creation moved to OCS in an earlier release, which derives the filename server-side; the exported sanitiser implied a client-side guarantee that no longer applied.
- **CI runs the test suite** (#18) and a production dependency audit. Integration tests self-skip without credentials; the new deterministic unit tests always run.
- **Release tarball no longer ships compiled tests** (#19) — `tsconfig.build.json` excludes `**/*.test.ts`.
- **README corrected** (#20): the installation example pinned a stale `0.2.1` filename, and the development section named `MCP_TEST_COLLECTIVE` where the suite reads `MCP_TEST_COLLECTIVE_ID`, so contributors saw every integration test skip.
- **All 41 tools carry MCP annotations** (#21) — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, and a human title — so clients can distinguish a read from an irreversible delete without parsing prose. Registry-level tests enforce that every tool is annotated and that the destructive ones are marked correctly.

---

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
