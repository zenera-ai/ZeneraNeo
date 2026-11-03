# Sharing a project - `zen export` and `zen import`

A project is a directory, so moving one is a zip - except that half of the
directory belongs to that machine rather than to the project. These two write
and read the other half.

## `zen export`

```
zen export [project] [--out <file>] [--no-vectors] [--no-memory] [--force]
```

Aliases: `pack`, `archive`, `share`.

Writes `./<project>-<stamp>.zip` in the working directory unless `--out` names
somewhere else. The stamp means two exports in one afternoon are two files, not
one silently replaced; an `--out` that already exists is a usage error until
`--force`.

| Flag           | Meaning                                                      |
| -------------- | ------------------------------------------------------------ |
| `--out <file>` | Where the archive goes                                       |
| `--no-vectors` | Leave out `assets/**/lance/` - much smaller, needs a restore |
| `--no-memory`  | Leave out `memory/` entirely                                 |
| `--force`      | Overwrite the target                                         |

### What travels

Everything that is the project: `agents.yaml`, the `agents/` tree,
`SPECIFICATION.md` and its feedback, `assets/`, `memory/`, `sandbox/`,
`scripts/`, and the editor files (`.github/`, `.vscode/`).

What does not: `sessions/`, `.tmp/`, `.git/`, `node_modules/`, lock files,
`.DS_Store`, any `*.zip` at the top of the project (the default destination
puts one there, and a second export must not pack the first), and `.env`.
Symbolic links are counted and never followed. A zip that is genuine project
material lives under `assets/`, where this rule does not look.

**The values in `.env` never travel, behind no flag.** The names do, as a
`.env.example` with every value blank and every comment kept - so the other end
knows which credentials to supply without being handed any.

### The vectors travel by default

This is the decision the command is built around. A rag index without its
`lance/` tree looks built and cannot search, and memory has no fallback at all:
a memory without its vectors recalls by term overlap until every node is
written again. So the default archive works when it is opened. The memory
travels as a snapshot of its database taken at one moment, so a run writing to
it meanwhile cannot tear the archive.

`--no-vectors` makes a much smaller one for someone who will run
`zen rag <subject> restore` on arrival. The manifest records the choice and
`zen import` prints the restore step when it was taken.

### What it refuses

Nothing for being busy: memory is copied as of one moment, so a run writing
to it meanwhile cannot tear the archive.

A project that fails `zen check` is exported anyway, with a warning. Sending
someone a broken project to ask for help is a legitimate reason to export one.

`--json` prints `{file, bytes, files, project, root, vectors, memory, skipped, ok}`.

## `zen import`

```
zen import <file.zip> [dir] [--name <name>] [--force] [--no-register]
```

Aliases: `unpack`.

Unpacks into `./<project>` unless a directory is named, and registers it so
`zen list` and `zen open` find it by name. A target directory with anything in
it is refused until `--force`.

| Flag            | Meaning                                             |
| --------------- | --------------------------------------------------- |
| `--name <name>` | Register under this name - use it when one is taken |
| `--force`       | Write into a directory that is not empty            |
| `--no-register` | Unpack and leave the registry alone                 |

A zip without `zenera-export.json` at its root is a usage error: only an archive
`zen export` wrote can be imported.

### It treats the archive as hostile

Every path, size and mode in a zip is a claim made by whoever sent it. So:
entry paths that are absolute, contain `..`, or fall outside the single
directory the manifest names are refused; an entry claiming to be a symbolic
link is refused; the entry count and unpacked size are bounded; and file modes
are replaced rather than honoured (`0644`, and `0755` for `*.sh` only).

**Nothing in the archive is executed** - not `scripts/_setup.sh`, not the
Dockerfile, not a line of the `.github/` tree. The commands to run next are
printed instead, so they can be read before they are typed.

### After importing

```sh
cp .env.example .env     # and fill in the credentials; they were not in the archive
zen check <name>         # what this machine is still missing
zen rag <subject> restore  # only when the archive was made with --no-vectors
zen open <name>
```

`--json` prints `{dir, name, files, bytes, registered, from, vectors, memory}`.
