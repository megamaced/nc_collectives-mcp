# Nextcloud Collectives OCS API — Verified Endpoint Reference

Extracted from the [official OpenAPI spec](https://raw.githubusercontent.com/nextcloud/collectives/main/openapi.json) (v4.4.0, OpenAPI 3.0.3) and **live-tested** against a real Nextcloud 33 + Collectives 4.4.0 instance.

All paths are relative to `/ocs/v2.php/apps/collectives/api/v1.0`. All requests require `OCS-APIRequest: true` header and Basic Auth. Responses use the standard OCS envelope: `{"ocs": {"meta": {...}, "data": {...}}}`.

## Gotchas we hit during implementation

1. **Page body has no OCS endpoint.** The `PageInfo` schema has no `body`/`content` field. You **must** use WebDAV (`GET`/`PUT` on `/remote.php/dav/files/{user}/...`) to read or write markdown content.
2. **Tag colours are varchar(6)** — send `2d7d46`, not `#2d7d46`. The `#` prefix causes a database overflow.
3. **No collective rename endpoint.** `PUT /collectives/{id}` only accepts `{emoji}`. The `name` field is set at creation and cannot be changed via the API.
4. **`PUT /collectives/{id}` is for emoji only.** Permission levels use separate sub-path endpoints (`/editLevel`, `/shareLevel`). There is no `/emoji` sub-path.
5. **Scoped search is at `/collectives/{id}/search`**, not `/collectives/{id}/pages/search`.
6. **Templates are under `/pages/templates`**, not `/templates`.
7. **Page CRUD should use OCS, not WebDAV.** The OCS endpoints handle folder promotion, indexing, and naming atomically. WebDAV-based create/rename/move is fragile (race conditions, manual path math, no folder page support).
8. **Moving a page via OCS can change its Nextcloud file ID.** The `GET /pages/{id}` endpoint may 404 on the new ID until re-indexed. Use `GET /pages` (list all) as a fallback.
9. **Attachment responses have no `pageId` field.** You must track pageId from your own context.

---

## Collectives

| Method | Path | Body | Returns | Notes |
|--------|------|------|---------|-------|
| `GET` | `/collectives` | — | `{collectives: [...]}` | List all accessible collectives |
| `POST` | `/collectives` | `{name, emoji?}` | `{collective: {...}}` | Also creates underlying Team |
| `PUT` | `/collectives/{id}` | `{emoji}` | `{collective: {...}}` | **Emoji only** — no name change |
| `DELETE` | `/collectives/{id}` | — | `{collective: {...}}` | Soft-delete (moves to trash) |
| `PUT` | `/collectives/{id}/editLevel` | `{level}` | `{collective: {...}}` | Set edit permission level |
| `PUT` | `/collectives/{id}/shareLevel` | `{level}` | `{collective: {...}}` | Set share permission level |
| `PUT` | `/collectives/{id}/pageMode` | `{mode}` | `{collective: {...}}` | 0=view, 1=edit |

## Collective Trash

| Method | Path | Body | Returns | Notes |
|--------|------|------|---------|-------|
| `GET` | `/collectives/trash` | — | `{collectives: [...]}` | |
| `PATCH` | `/collectives/trash/{id}` | — | `{collective: {...}}` | Restore from trash |
| `DELETE` | `/collectives/trash/{id}` | — | `{collective: {...}}` | Permanent delete. Add `?circle=true` to also delete the Team |

## Pages

| Method | Path | Body | Returns | Notes |
|--------|------|------|---------|-------|
| `GET` | `/collectives/{cId}/pages` | — | `{pages: [...]}` | List all pages (flat, use parentId for tree) |
| `GET` | `/collectives/{cId}/pages/{id}` | — | `{page: {...}}` | Single page metadata (no body content) |
| `POST` | `/collectives/{cId}/pages/{parentId}` | `{title, templateId?}` | `{page: {...}}` | **parentId is in the URL path, not body** |
| `PUT` | `/collectives/{cId}/pages/{id}` | `{title?, parentId?, index?, copy?}` | `{page: {...}}` | Rename, move, copy, reorder — all via this one endpoint |
| `DELETE` | `/collectives/{cId}/pages/{id}` | — | — | Trash a page (summary: "Trash a page") |
| `PUT` | `/collectives/{cId}/pages/{id}/emoji` | `{emoji}` | `{page: {...}}` | Set/clear emoji |
| `PUT` | `/collectives/{cId}/pages/{id}/fullWidth` | `{fullWidth}` | `{page: {...}}` | Toggle full-width layout |
| `PUT` | `/collectives/{cId}/pages/{id}/subpageOrder` | `{subpageOrder}` | `{page: {...}}` | Set child page ordering |
| `GET` | `/collectives/{cId}/pages/{id}/touch` | — | `{page: {...}}` | Bump timestamp without changing content |
| `PUT` | `/collectives/{cId}/pages/{id}/to/{newCollectiveId}` | — | — | Cross-collective move |

## Page Trash

| Method | Path | Body | Returns | Notes |
|--------|------|------|---------|-------|
| `GET` | `/collectives/{cId}/pages/trash` | — | `{pages: [...]}` | |
| `PATCH` | `/collectives/{cId}/pages/trash/{id}` | — | `{page: {...}}` | Restore. **Method is PATCH, not PUT or POST** |
| `DELETE` | `/collectives/{cId}/pages/trash/{id}` | — | — | Permanent delete |

## Tags

| Method | Path | Body | Returns | Notes |
|--------|------|------|---------|-------|
| `GET` | `/collectives/{cId}/tags` | — | `{tags: [...]}` | |
| `POST` | `/collectives/{cId}/tags` | `{name, color}` | `{tag: {...}}` | **color is 6 hex chars without `#`** |
| `PUT` | `/collectives/{cId}/tags/{id}` | `{name, color}` | `{tag: {...}}` | |
| `DELETE` | `/collectives/{cId}/tags/{id}` | — | — | |
| `PUT` | `/collectives/{cId}/pages/{id}/tags/{tagId}` | — | — | Add tag to page |
| `DELETE` | `/collectives/{cId}/pages/{id}/tags/{tagId}` | — | — | Remove tag from page |

## Search

| Method | Path | Body | Returns | Notes |
|--------|------|------|---------|-------|
| `GET` | `/collectives/{cId}/search?searchString=...` | — | `{pages: [...]}` | Scoped to one collective. **Not** `/pages/search` |

## Templates

| Method | Path | Body | Returns | Notes |
|--------|------|------|---------|-------|
| `GET` | `/collectives/{cId}/pages/templates` | — | `{templates: [...]}` | **Under `/pages/templates`**, not `/templates` |
| `POST` | `/collectives/{cId}/pages/templates/{id}` | `{title, parentId}` | `{template: {...}}` | `{id}` semantics unclear for POST — may need template root page |
| `PUT` | `/collectives/{cId}/pages/templates/{id}` | `{title}` | `{template: {...}}` | Rename |
| `PUT` | `/collectives/{cId}/pages/templates/{id}/emoji` | `{emoji}` | `{template: {...}}` | |
| `DELETE` | `/collectives/{cId}/pages/templates/{id}` | — | — | |

## Attachments

| Method | Path | Body | Returns | Notes |
|--------|------|------|---------|-------|
| `GET` | `/collectives/{cId}/pages/{id}/attachments` | — | `{attachments: [...]}` | Response has: id, name, filesize, mimetype, timestamp, path, internalPath, hasPreview. **No pageId field** |
| `POST` | `/collectives/{cId}/pages/{id}/attachments` | multipart file | `{attachment: {...}}` | OCS upload alternative to WebDAV PUT |
| `PUT` | `/collectives/{cId}/pages/{id}/attachments/{aId}` | `{name}` | `{attachment: {...}}` | Rename |
| `DELETE` | `/collectives/{cId}/pages/{id}/attachments/{aId}` | — | — | Delete by attachment ID |
| `PATCH` | `/collectives/{cId}/pages/{id}/attachments/trash/{aId}` | — | `{attachment: {...}}` | Restore trashed attachment |

## User Settings

| Method | Path | Body | Returns | Notes |
|--------|------|------|---------|-------|
| `PUT` | `/collectives/{cId}/userSettings/favoritePages` | `{favoritePages}` | — | Value is a **JSON-stringified** array: `"[1,5,23]"` |
| `PUT` | `/collectives/{cId}/userSettings/pageOrder` | `{pageOrder}` | — | 0=byOrder, 1=byTimeAsc, 2=byTitleAsc, 3=byTimeDesc, 4=byTitleDesc |
| `PUT` | `/collectives/{cId}/userSettings/showMembers` | `{showMembers}` | — | boolean |
| `PUT` | `/collectives/{cId}/userSettings/showRecentPages` | `{showRecentPages}` | — | boolean |

## Shares

| Method | Path | Body | Returns | Notes |
|--------|------|------|---------|-------|
| `GET` | `/collectives/{cId}/shares` | — | shares array | List collective shares |
| `POST` | `/collectives/{cId}/shares` | `{password?}` | `{share: {...}}` | Create public share link |
| `PUT` | `/collectives/{cId}/shares/{token}` | `{editable, password?}` | `{share: {...}}` | |
| `DELETE` | `/collectives/{cId}/shares/{token}` | — | — | |
| `POST` | `/collectives/{cId}/pages/{pId}/shares` | `{password?}` | `{share: {...}}` | Page-level share |
| `PUT` | `/collectives/{cId}/pages/{pId}/shares/{token}` | `{editable, password?}` | `{share: {...}}` | |
| `DELETE` | `/collectives/{cId}/pages/{pId}/shares/{token}` | — | — | |

## What MUST use WebDAV (no OCS equivalent)

| Operation | WebDAV endpoint | Notes |
|-----------|----------------|-------|
| Read page body | `GET /remote.php/dav/files/{user}/{collectivePath}/{filePath}/{fileName}` | Returns raw markdown |
| Write page body | `PUT /remote.php/dav/files/{user}/{collectivePath}/{filePath}/{fileName}` | Raw markdown body |
| Upload attachment (simple) | `PUT /remote.php/dav/files/{user}/.../attachments.{pageId}/{filename}` | Simpler than multipart OCS POST |
| List file versions | `PROPFIND /remote.php/dav/versions/{user}/versions/{fileId}` with `Depth: 1` | Returns XML multistatus |
| Restore file version | `COPY /remote.php/dav/versions/{user}/versions/{fileId}/{versionId}` | `Destination` header = live file URL |
