# Browser-local domain compatibility

The paid Pages build can set `PAID_LOCAL_COMPATIBILITY` in its external `pages.env`:

```sh
PAID_LOCAL_COMPATIBILITY='{"sourceOrigin":"https://image.nainma.online","targetOrigin":"https://muvloom.online"}'
```

`pages-release.sh` passes `LOCAL_COMPATIBILITY` to the static runtime-config generator. Both origins must serve the same release, including `/local-compat.html`. Leave it unset for other deployments. Preserve the legacy `BFF_BASE_URLS_BY_ORIGIN` mapping for login cookies.

Before importing application stores, the target opens a hidden source bridge. The bridge checks existing storage access and requests the non-cookie Storage Access handle only when silent access is available. It reads app-owned IndexedDB databases and localStorage keys from the original unpartitioned storage. Images and attachment files travel through a MessageChannel as native binary values, one record at a time; each acknowledgment follows a committed local write. No browser data is uploaded to a server.

The source is read-only. Existing destination records stay intact. Conflicting nonempty drawings become separately editable local projects named “旧站画布”, with their original ordering and files. Other conflicts remain in `muvloom-legacy-backup`. Unreferenced legacy drawings also receive a project index. Local media is protected from replacement by text-only cloud documents.

A completion marker is written only after the complete stream is imported. Interrupted transfers can retry without duplicating recovered projects. This is a one-time domain compatibility step, not continuous synchronization between domains or devices. Keep the old origin available throughout the transition.

Browser privacy restrictions may deny silent access. The startup flow then returns to the old workbench, retaining its usable local data; it does not request permission or show a migration error screen. This fallback keeps the old domain visible. A universal silent transfer across unrelated origins is not available in all browsers.

## Project identity and placeholder repair

Compatibility version 2 replays the original read-only source once for browsers that completed version 1. Existing project IDs and scene keys stay stable. Missing project covers and conversation links are filled from the corresponding source project. An empty local scene is restored in place only when a version-1 recovery copy exists and the original project edit timestamp still matches the source project. Changed or unproven empty scenes remain intact with a separate recovery copy. Scenes with existing content remain protected. An earlier auto-generated recovery copy is removed only when its default name and timestamps indicate no edits and its drawing matches the restored source exactly.

Projects have `/p/<encoded project ID>` addresses. A project URL takes precedence over the last local selection; browser history uses the same save-and-switch operation as the project picker. Unknown or unavailable IDs show an error without silently switching to a different project. Local-only project links still require the browser that owns the data; adding a URL does not make local media publicly shared.
