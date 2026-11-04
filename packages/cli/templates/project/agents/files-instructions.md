---
requires: [files]
---

# Working with files

These rules govern how files are discovered, inspected, and modified. If file tools
are not among your tools, you cannot read or change files directly.

## Access modes

Check which tools you actually have:

- If `write_file` or `apply_patch` is not among your tools, your access is **read-only**.
  Inspect files, search directories, and report conclusions, but attempt no edits.
- If `write_file` and `apply_patch` are available, you may create and edit files
  under `/workspace`.

## Finding files

Never guess a file's name, location, or contents. Pick the tool by what you know:

- **The directory** → `list_dir { path }`. One level, not recursive. Each file shows
  `format`, `bytes` and, for text, `lines`, so you can decide what to read and how much
  without opening it. Omit `path` (or give `/`) to list the mounted trees.
- **Part of the path** → `find_files { pattern, path? }`. `pattern` is **required**: a
  plain, case-insensitive substring, never a glob or regex (`*.ts` matches nothing; write
  `.ts`). It is matched against the path with its mount name (`/workspace`, `/assets`, …)
  removed: `/workspace/src/a.ts` is matched as `src/a.ts`, so `src/` matches and
  `/workspace/src` does not. To limit the search to one tree, pass it as `path`. Matches
  come back as absolute paths.
- **Neither** → `list_dir` the root, then descend.

`find_files` matches paths, not contents. Both tools stop at 500 results and set
`truncated`: narrow the `pattern` or `path` rather than repeating the call.

## Reading files

- `read_file { path, start_line?, end_line? }`; lines are 1-based and inclusive. Read a
  short file whole; for a long one (see `lines` from `list_dir`), read the range you need.
- The result gives the file's total `lines` and the `start_line`/`end_line` returned.
  `truncated: true` means more follows `end_line` (your range or the 256 KB cap); continue
  from `end_line + 1` only if you need it.
- A non-text file fails with its `format`. Do not retry; `copy_file` can still copy it.
- Check whether a target exists before writing to it.

When a tool returns `error` with a `hint`, act on the hint instead of repeating the call.

## Modifying files

### Modifying existing files: `apply_patch`

Always use `apply_patch` to edit existing files. It makes surgical, verifiable changes
and validates the entire patch before writing any file to disk.

1. **Read before patching**: Read the target file first to obtain exact context lines.
   An outdated or imagined context line fails the patch.
2. **Provide context**: Include at least 3 unchanged context lines (prefixed with a space)
   before and after each change.
3. **No line numbers**: Patches match on context text, never on line numbers.
4. **Always close the patch**: Every patch must begin with `*** Begin Patch` and end
   with `*** End Patch`. Omitting `*** End Patch` is an error.

Example patch:

```
*** Begin Patch
*** Update File: /workspace/src/config.ts
@@ port configuration
 export interface Config {
     host: string;
-    port: 80;
+    port: 8080;
     timeoutMs: number;
 }
*** End Patch
```

### Creating new files: `write_file`

Use `write_file` only to create a **new** file or to overwrite a small file completely.
Never use `write_file` to update an existing file when only a few lines need to change.

### Copying: `copy_file`

Use `copy_file` to duplicate a file, never `read_file` + `write_file`. The bytes skip the
conversation, so there is no size cap and binaries arrive intact.

- The source may be in a read-only mount; only the destination must be writable.
  This is how something under `/assets` or `/skills` reaches `/workspace`. Remembered
  files are not mounted; `memory_copy_file` brings one into the workspace.
- Set `overwrite: true` only when intentionally replacing an existing destination.
- Copying a directory and its contents requires `recursive: true`.

### Moving and deleting

- Use `move_file` to rename or relocate a file or directory. It creates parent directories
  as needed. Set `overwrite: true` only when intentionally replacing an existing destination.
- Use `delete_file` to remove a file. Removing a directory requires `recursive: true`.

## Mounts and containment

All file operations are confined to mounted trees:

- `/workspace`: The primary writable directory for the project. Paths inside the workspace
  (such as `/workspace/src/main.ts`) are where project files reside.
- `/assets`, `/skills`: Read-only mounts. You may read, list, and search them,
  but you cannot write, move, or delete files inside them.
- Any attempt to reach outside these mounts fails with a containment error.
