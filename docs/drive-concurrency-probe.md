# Google Drive concurrency probe

A one-time probe on 2026-11-02 used a personal Google Drive account, the
`drive.file` scope, and synthetic files inside a newly created folder. Google
accepted the request to move that folder to the trash afterward. No real vault
files were used.

## Observed results

- A v2 `files.get` returned an ETag. For a v2 media `PUT` with `If-Match`, a
  current ETag succeeded, a stale ETag returned HTTP 412, and two simultaneous
  writes using the same current ETag produced one success and one HTTP 412.
- A v3 media `PATCH` accepted an `If-Match` using a v2 ETag even after that
  ETag became stale. Two simultaneous writes using the same ETag both succeeded.
  This does not establish the behavior of every possible v3 precondition.
- Two different files with the same name could be created in the same folder.

## Implications and limits

The fork now tracks Drive's monotonic file version and file ID and uses v2
conditional media writes. A metadata read followed by an unconditional v3
write is not enough.

## Follow-up provider probe

On 2026-11-03, the changed provider was exercised against synthetic files in
separately created, uniquely named folders in the same personal account. Each
folder was verified and moved to Drive trash. No real vault was used.

- Creating and reading a file, updating it, and editing then reverting it worked;
  the file version distinguished the reverted content from its earlier version.
- Two competing updates based on the same observation produced one success and
  one HTTP 412. A stale observed version was also refused.
- A v2 metadata PATCH to trash a file returned HTTP 412 when another update was
  injected after its ETag was observed. The newer content remained live. A
  subsequent trash request for the unchanged version succeeded (HTTP 200).
- Drive file versions changed between some reads without an explicit content
  write from the probe. This caused safe precondition failures. For the trash
  tests only, a probe-only wrapper retried after checking that the file ID and
  bytes were unchanged. It did not retry after the injected content edit; that
  is the request which received HTTP 412. This wrapper is not in the plugin.

These are observations for one account and synthetic files, not a guarantee for
other accounts or devices. Concurrent Drive creation is still non-atomic and may
require manual duplicate resolution. External file writers, actual Obsidian
Linux/Android integration, and token protection have not been validated. Do not
use the current fork with a real vault.
