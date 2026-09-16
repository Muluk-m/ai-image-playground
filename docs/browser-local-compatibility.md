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
