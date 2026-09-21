---
status: accepted
---

# Course publishing goes through a CourseStorage boundary, and Google Drive is a backend

This fork publishes to a Google Drive account instead of Dropbox. Rather than rewriting the Dropbox publish in place, the Publish now talks to a course-scoped `CourseStorage` (`apps/local/app/services/course-storage.ts`), with a Dropbox implementation that issues exactly the requests it always did and a Google Drive one beside it. `COURSE_STORAGE_BACKEND` picks one.

> **Update: Dropbox removed.** The Dropbox backend has since been deleted outright, and Google Drive is the only course storage backend. `COURSE_STORAGE_BACKEND` and every `DROPBOX_*` setting are gone, as are the Dropbox OAuth routes, its HTTP client and its fake. `CourseStorage` stays as the seam: it documents what a Publish needs from a store, and the Drive implementation is its only one. With a single backend the Byte Hash is simply SHA256, so `byteHashOf` went too and the Export Digest no longer computes Dropbox's block `content_hash`; sidecars that already hold a `contentHash` are still read, and the field is ignored. The Dropbox upload and reuse suites were ported to the fake Drive before they were deleted. Drive is connected from the publish page ("Connect Google Drive"), which disables Publish until it is. The `dropbox_auth` table stays in the schema, unused, because migrations are additive-only (ADR 0026). The sections below describe the decision as it was made.

Everything the Publish guarantees stays the same. Bundles are addressed by recipe ([ADR 0023](0023-dropbox-bundle-addressing.md)). Which bytes go over the wire is decided by the Byte Hash ([ADR 0027](0027-byte-hash-decides-the-send.md)). An interrupted Publish resumes, and `course.json` is the only commit marker and the last thing written. This ADR records how Google Drive keeps those guarantees, because Drive's object model differs from Dropbox's in three ways that matter.

## Drive addresses by ID, not by path

The boundary speaks in course-relative paths (`versions/{fp}/{section}/{lesson}/{title}.mp4`). The Drive backend turns these into folder IDs, starting from the folder named after the Course inside `GOOGLE_DRIVE_COURSES_FOLDER_ID`. The environment names that root folder by ID, not by path, because an ID stays valid when the folder is renamed or moved.

Drive also lets one folder hold several items with the same name. Two rules keep the tree deterministic:

- **The oldest match wins.** Lookups list children ordered by `createdTime` and take the first match. A duplicate left behind by an interrupted attempt can never hide the original.
- **Folders are created one at a time, behind a lock, and only after looking again.** Up to four Videos upload into the same lesson folder at once. Without the lock, each could see the folder missing and create its own copy.

## The Byte Hash is SHA256

For every stored binary file, Drive reports `sha256Checksum`, so the Drive backend's Byte Hash is the file's SHA256. That is the same number the manifest records. Uploads are verified against it, landed files are adopted against it, and server-side copies (`files.copy`) are checked with it. Dropbox's block `content_hash` is still computed and cached in the Export Digest sidecar, so switching backends never makes a cached digest invalid.

Resumable uploads send 256 KiB-aligned chunks. When Drive reports (`308`, `Range`) that it kept fewer bytes than were sent, the rest is re-read from disk and sent again. Only bytes that haven't already been hashed are passed to the digest, so the SHA256 still describes each byte exactly once.

## The commit is an in-place content replacement of one file

Dropbox committed by overwriting `course.json` in one step. On Drive, "overwrite" could mean creating a new file with the same name, which would leave readers able to see two receipts, or none at all between a delete and a create. Instead:

- `course.json` keeps **one file ID for its whole life**. The first commit creates it. Every later commit replaces its content in place with `files.update` (`uploadType=media`).
- Drive makes the new content the file's head revision in a single step. A reader of that file ID sees either the previous receipt or the new one, never a partial file and never an absent one. Earlier receipts remain available as revisions.
- **Consumers resolve the receipt exactly as the Publish does:** they take the oldest non-trashed `course.json` in the Course folder. They should then read it by file ID.

## Consequences

- `COURSE_STORAGE_BACKEND=google-drive` requires `GOOGLE_DRIVE_COURSES_FOLDER_ID`, `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET`, plus a one-time connection at `/api/auth/google-drive/initiate`. The scope is full `drive`, because the Publish writes into a folder the author created by hand, which the narrower `drive.file` scope cannot see.
- Tokens are stored in the additive `google_drive_auth` table (migration `0023`), in the same shape as `dropbox_auth`.
- A Drive publish uses `files.copy` once per reused Video instead of Dropbox's single `copy_batch_v2`. Copies run four at a time and are reported per entry, so one source that has vanished falls back to an upload without failing the rest.
- The fake Drive (`test-utils/fake-google-drive.ts`) implements the list/get/create/copy/update endpoints and the multipart, media and resumable upload protocols. It also supports failure injection, and can make one resumable chunk upload store only part of its bytes, so the resend path is exercised. The Drive publish suite runs the real publish against it.
