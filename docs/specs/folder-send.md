# Folder-as-Folder Send — Preserve Directory Tree End-to-End

**Status:** Most of the picker/recurser scaffolding already ships. Real gap is
on the wire protocol and receiver side. Scope: ~150 LOC across 2 files.

**The differentiator we're building**

> Every other browser-based P2P transfer tool (ToffeeShare, WeTransfer, Smash,
> Snapdrop) handles "folder" by saying "zip it first." Our existing folder
> picker also collapses the tree into a single `.zip` blob on the sender via
> `client-zip`. We want users to **drop a folder, send, and have the
> receiver get the same folder structure back — actual nested directories,
> not a zip they have to unpack.**

This is something even Apple AirDrop doesn't do cleanly (turns into a
loose flat list of files unless you zip first). Real positioning gain.

---

## ✅ Already shipped (verified by reading code)

| Capability | Where | How |
|---|---|---|
| `<input type="file" webkitdirectory multiple>` | `transfer.astro:467` | Hidden input, triggered by "Pick folder" button |
| Folder drag-drop via `webkitGetAsEntry()` | `transfer.astro:2389-2424` | Recurses with `walkEntry()` |
| Captures relative path per file | `transfer.astro:2376-2380` | Uses `webkitRelativePath` from picker, manual prefix from drag-drop |
| `showDirectoryPicker` for "Save all to folder" | `transfer.astro:902, 925` | Chromium-only, falls back to per-file Save |
| Per-file row UI with Save button | `transfer.astro` makeRecvRow | Already supports many files in flight |

---

## ❌ The real gap

| Gap | Today | After |
|---|---|---|
| **Wire protocol carries path** | `FileMeta = {id, name, size, mime}` — no path | Add optional `path?: string` field. Old peers fall back to `name`. |
| **Sender splits a folder pick into N file sends** | Zips locally, sends 1 `.zip` | Sends N individual files, each with `path: "FolderName/sub/file.ext"` |
| **Receiver groups files by folder** | Flat list of N rows | Files with same root folder prefix grouped in a collapsible tree |
| **`Save all to folder` recreates subdirs** | Saves all files flat at picked-folder root | Uses `dir.getDirectoryHandle(part, {create:true})` for each path segment |
| **Per-file Save preserves path** | Uses just `meta.name` | Uses `meta.path ?? meta.name` (legacy compat) |

The existing `client-zip` path stays as a **fallback** for browsers that
don't support `showDirectoryPicker` (Firefox + Safari mostly) and as an
opt-in toggle (some users will still want a single .zip file).

---

## 📋 Plan — 2 commits

### Commit 1 — `feat(folders): preserve directory tree in wire protocol + sender split`

**Scope:** wire-protocol field add + sender behavior change. Receiver
still works on flat names (back-compat); the tree-grouping arrives in
commit 2.

**Files:**
- `src/lib/fileTransfer.ts` — add `path?: string` to `FileMeta` (~3 LOC)
- `src/pages/transfer.astro` — replace zip path in folder picker + drag-drop
  with per-file send loop (~50 LOC)

**`FileMeta` change:**

```ts
export interface FileMeta {
  id?: string;
  name: string;
  size: number;
  mime: string;
  /**
   * Optional folder-relative path of this file, including the leading
   * folder name (e.g. "MyPhotos/2024/IMG_1234.jpg"). Set when the user
   * picked a folder; omitted for individual file picks. Receivers that
   * support it group files in a tree and recreate subdirs on Save All;
   * older receivers fall back to using `name`.
   */
  path?: string;
}
```

The `path` field is forward-compatible — `JSON.stringify` includes it,
old `JSON.parse(...).path` is just `undefined`, old receivers ignore it.

**Sender wiring change (`transfer.astro`):**

Add a new method to `FileTransfer`:

```ts
async sendWithPath(file: File, relativePath: string) {
  // Same as send(file) but seeds meta.path from caller.
  // ... existing body, but pass meta.path = relativePath
}
```

Or simpler — overload `send()` to accept an optional path:

```ts
async send(file: File, path?: string) {
  const meta: FileMeta = {
    id: makeId(),
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
    ...(path ? { path } : {}),
  };
  // ... rest unchanged
}
```

Then in `transfer.astro`, replace `zipFilesAndQueue` calls with a new
`sendFolderAsFiles()` helper:

```ts
/**
 * Queue all files from a folder pick / drop as individual sends, each
 * tagged with its relative path. Receivers group them visually; "Save
 * all to folder" recreates the directory tree on disk.
 *
 * Fallback to zip available via the "Send as .zip instead" toggle, useful
 * when the receiver can't use showDirectoryPicker (Firefox / Safari).
 */
const sendFolderAsFiles = async (
  files: { file: File; path: string }[],
) => {
  if (files.length === 0) return;
  // Build a DataTransfer + FileList wrapper so the existing onPickFiles()
  // queueing machinery (drag-reorder, thumbnails, etc.) just works.
  const dt = new DataTransfer();
  for (const { file } of files) dt.items.add(file);
  // Stash paths on a parallel side-channel since DataTransfer doesn't
  // let us tag files with extra metadata. Indexed by file identity.
  // Note: WeakMap won't survive serialization, fine — these objects
  // live entirely in-memory in the page lifetime.
  for (const { file, path } of files) {
    pendingPathByFile.set(file, path);
  }
  onPickFiles(dt.files);
};
```

And then in the actual `sendFiles()` call site (where queued files
hit the wire), thread through the path:

```ts
// existing
await transfer.send(file);
// becomes
await transfer.send(file, pendingPathByFile.get(file));
```

**Folder picker + drag-drop call site change:**

Replace `zipFilesAndQueue(arr, ...)` with `sendFolderAsFiles(arr)`. Keep
the zip code path alive but behind a one-line localStorage toggle
`p2pds:folderSendMode === "zip"` so power users / Firefox can opt in.

(Decided to keep the zip path because some users may want a single .zip
download instead of N files appearing on their disk. We'll surface this
toggle later if anyone asks; default = tree-preserving.)

**Files to gate against `length === 1` regression:**

If a "folder" pick yields exactly one file (unusual but possible —
user picked a folder with one file), `meta.path` will still be set and
the receiver UI will group it under a folder header. That's the correct
behavior. No special-case needed.

---

### Commit 2 — `feat(folders): receiver tree grouping + Save All recreates subdirs`

**Scope:** receiver-side rendering + folder-aware Save All. Two files
touched, ~80 LOC.

**Files:**
- `src/pages/transfer.astro` — tree grouping in `makeRecvRow()`, Save All
  recursion

**Tree grouping logic:**

```ts
/**
 * Bucket received files by their top-level folder. Files without a
 * meta.path go into a "Loose files" pseudo-group at the top.
 *
 * Returns a Map keyed by top-level folder name (or "" for loose), with
 * the file list preserving send order within each group.
 */
const groupReceivedByFolder = (
  items: ReceivedItem[],
): Map<string, ReceivedItem[]> => {
  const groups = new Map<string, ReceivedItem[]>();
  for (const item of items) {
    const rootFolder = item.path?.includes("/")
      ? item.path.split("/")[0]
      : "";
    if (!groups.has(rootFolder)) groups.set(rootFolder, []);
    groups.get(rootFolder)!.push(item);
  }
  return groups;
};
```

**Render change in `makeRecvRow()`:**

Add a folder-header row above the file row when this file is the FIRST
of a new folder group. Folder header shows:
- Folder icon SVG
- Folder name + "(N files, M total)" subtitle
- Collapse/expand toggle
- Folder-level progress aggregate (sum of all files in group)

The actual file rows are nested visually (left-indented) below the
folder header. Same per-file Save / Resume badges as today; the only
visual change is the header + indent.

**`Save all to folder` recursion:**

```ts
/**
 * Walk a/b/c.txt → ensure a/, then a/b/, then write c.txt.
 * Returns the file handle for the final segment.
 */
const ensureSubdirsAndGetFileHandle = async (
  rootDir: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<FileSystemFileHandle> => {
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Error("ensureSubdirs: empty path");
  }
  const fileName = segments.pop()!;
  let dir = rootDir;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  // Collision handling per-folder (uniqueName lifted to be dir-aware,
  // already is).
  const safe = await uniqueName(dir, fileName);
  return dir.getFileHandle(safe, { create: true });
};
```

In the existing `saveAllBtn` handler, swap `dir.getFileHandle(safeName, ...)` for:

```ts
const fh = item.path
  ? await ensureSubdirsAndGetFileHandle(dir, item.path)
  : await dir.getFileHandle(await uniqueName(dir, item.name), { create: true });
```

**`uniqueName()` already accepts a dir param** so per-subdir collision
handling Just Works (each subdir has its own foo-1.png / foo-2.png
namespace).

**Per-file Save button** also updates to use `item.path ?? item.name`
as the suggested filename in `showSaveFilePicker` — preserves the
suggested folder name on individual saves too.

---

## 🧪 Verification

1. **Folder send: same browser-pair test**
   - Sender: `Pick folder` → choose a folder with 3-5 files in subdirs (e.g. `MyPhotos/2024/jan/` + `MyPhotos/2024/feb/`)
   - **Expected on receiver:** instead of one big `.zip` row, see `MyPhotos/` folder header + 5 file rows nested under it
   - Click `Save all to folder`, pick a destination
   - **Expected on disk:** `<picked>/MyPhotos/2024/jan/IMG_1.jpg` and `<picked>/MyPhotos/2024/feb/IMG_2.jpg` — actual tree
2. **Drag-drop folder** with mixed depth (test all 4 levels of nesting work)
3. **Mixed pick** — drag 2 loose files + 1 folder. Receiver sees loose
   files at top + the folder grouped below
4. **Browser without `showDirectoryPicker` (Firefox)** — Save All button
   stays hidden; per-file Save buttons offer the suggested filename
   `MyPhotos/2024/jan/IMG_1.jpg` (user picks where to save; their browser
   may flatten that to `MyPhotos_2024_jan_IMG_1.jpg` or similar — that's
   the browser's call)
5. **Legacy receiver** — old client on receiver side, new sender —
   `meta.path` field ignored, file shows with bare name in flat list
6. **Resume mid-folder transfer** — start sending 100-file folder, kill
   network at file 30, restart. File 30 resumes from byte offset (existing
   resume), files 31-100 continue normally. Tree groupings preserved on
   receiver throughout

---

## 🚫 Out of scope

- **Folder-level progress bar with aggregate ETA across all files** — nice
  to have, but every file already has its own progress row. Adding a
  parent aggregate is +50 LOC and pure UX polish — defer.
- **"Send as .zip instead" toggle in the UI** — code path is preserved
  internally (`zipFilesAndQueue` stays defined) but not surfaced as a
  toggle yet. Add only if a user asks.
- **Empty directory handling** — `webkitdirectory` doesn't enumerate empty
  folders, so we can't send them. Match WeTransfer / Dropbox behavior:
  silently skip. Not a real-world issue (empty folders are rare to share).
- **Folder rename on send** — would need a UI field per pick. Out of scope.
- **Per-folder "Save this folder only" button** — possible follow-up. Defer.
- **Symlinks** — the picker / `webkitGetAsEntry` doesn't surface them as
  links; they're resolved to the target file. No special handling needed.

---

## 🔧 Decisions to confirm before coding

1. **Default behavior:** tree-preserving (per-file sends) — not zip. Zip
   code stays as an internal fallback if anyone needs it later.
2. **Receiver UI:** folder header with collapse toggle + indented files.
   Loose files render at top, folders below.
3. **Save All:** recreates subdirs on Chromium (`showDirectoryPicker`);
   per-file fallback elsewhere with suggested name that includes the
   folder path.
4. **No new dependencies** — `client-zip` stays for the existing zip code
   path; no new libraries needed for per-file send (already supported by
   existing `FileTransfer.send()`).

If all 4 confirmed, plan is locked.
