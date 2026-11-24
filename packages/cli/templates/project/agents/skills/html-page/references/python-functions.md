# Python functions a page calls (`*.api.py`)

For a page that shows live data or saves changes. The core rules (where it
goes, the sandbox, adaptive layout, checks) are in `SKILL.md`.

Every **public function** in an `*.api.py` beside the page can be called from
the page's JavaScript by name, with its arguments as an object, and returns
JSON. No server code, routes or framework: write plain Python functions.

```js
const items = api('api/items'); // api/items.api.py
const list = await items.list_items({ show: 'open' }); // list_items(show="open")
await items.add_item({ title: 'Milk' }); // add_item(title="Milk")
```

The app template (`/skills/html-page/assets/app`) is a working example: a
list in SQLite with add, check off, filter and delete. Rename
`api/items.api.py` to what it holds; one `*.api.py` per area of the app
(`orders.api.py`, `customers.api.py`), shared helpers in plain `.py` files
beside them.

## Writing the functions

```python
from zenera.api import HttpError, connect

def _db():                                  # `_`: not callable from the page
    db = connect("app.sqlite")              # api/.data/app.sqlite, made on first use
    db.execute("CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, customer TEXT, total REAL, status TEXT)")
    return db

def list_orders(status: str = "open"):
    """Orders with this status, newest first."""
    return _db().execute(
        "SELECT * FROM orders WHERE status = ? ORDER BY id DESC", (status,)
    ).fetchall()                            # rows are dicts: returned as JSON as they are

def set_status(id: int, status: str):
    if status not in ("open", "paid", "cancelled"):
        raise HttpError(400, f"unknown status {status!r}")
    db = _db()
    with db:                                # commits, or rolls back on an exception
        cur = db.execute("UPDATE orders SET status = ? WHERE id = ?", (status, id))
    if cur.rowcount == 0:
        raise HttpError(404, f"no order {id}")
    return {"id": id, "status": status}
```

The rules:

- **Callable** = defined in the file, name not starting with `_`. Imported
  functions and `_helpers` are not reachable from the page.
- **Arguments** are keyword arguments from the JS object. Give each a type
  annotation (`int`, `float`, `bool`, `str`) and a default when optional: a
  value of the wrong type, a missing or an unknown argument is a 400 the page
  sees, with the reason. Lists and dicts arrive as they were sent.
- **Return** what the page needs, JSON-ready: dicts, lists, numbers, strings,
  `None`. Dates become ISO strings, `Decimal` a number, `NaN` `null`. Never
  return bytes: write a file (below) and return its name.
- **Errors**: `raise HttpError(status, "message the user can act on")` -
  400 for bad input, 404 for a missing record, 403 for not allowed. Any other
  exception is a 500 with its message; the traceback goes to the log.
- **Each call is a new process.** Nothing kept in a global variable is there
  the next time. Keep state in the database or in files.
- **Fast and small**: a call has 30 seconds and a few MB of arguments and
  result. Page through large tables (`limit`, `offset` arguments) and
  aggregate in SQL instead of returning every row.
- `print()` goes to the log, not to the page: use it freely to debug.
- **Validate everything** that comes from the page, and always use `?`
  placeholders in SQL - never build SQL from arguments with `f"..."`.

## Data

- `connect("app.sqlite")`: the page's SQLite database in the `.data` folder
  beside the `.api.py` (WAL, foreign keys on, rows as dicts). Create tables
  with `CREATE TABLE IF NOT EXISTS` in one `_db()` helper, as above, so a
  fresh copy starts by itself.
- `data_path("exports/report.csv")`: a path in the same folder, for other
  files it keeps.
- A file the page should download or show (a CSV export, a chart image):
  write it next to the page instead, e.g. `../exports/orders.csv` from
  `api/`, and return the relative name; the page links to it.
- An external database or service: connect from the function, with its
  address and credentials from environment variables
  (`os.environ["DATABASE_URL"]`). Only the project's `.env` names reach
  them. Never write a secret into a file of the page, and never return it.
- Packages: prefer the standard library (`sqlite3`, `json`, `csv`,
  `urllib.request`). Anything else must be installed in the sandbox
  (`pip install --user <pkg>`); say which in your reply.

## Who is calling

Every call runs as the signed-in user who opened the page, as the chat's own
commands do. `zenera.identity()` says who that is:

| Field     | What it is                                                                               |
| --------- | ---------------------------------------------------------------------------------------- |
| `.id`     | the user's id: stable, the one to store                                                  |
| `.email`  | their email, or `None`                                                                   |
| `.name`   | their display name, or `None`                                                            |
| `.role`   | `owner`, `editor`, `viewer` or `admin` in this project, or `None`                        |
| `.source` | `"host"` when the app signed them in; `"local"` on a test server (anyone could claim it) |

`zenera.identity()` is `None` when nobody is signed in.

The page itself cannot know who is signed in: give it a function that says so.

```python
import zenera
from zenera.api import HttpError

def me():
    """Who is using the page, for its header."""
    u = zenera.identity()
    if u is None:
        return None
    return {"id": u.id, "name": u.name or u.email or u.id, "role": u.role}

def _user():
    u = zenera.identity()
    if u is None:
        raise HttpError(401, "sign in to use this page")
    return u

def my_notes():
    """The caller's own notes."""
    return _db().execute("SELECT * FROM notes WHERE owner = ?", (_user().id,)).fetchall()

def delete_note(id: int):
    """Only the note's owner, or an owner of the project, may delete it."""
    u = _user()
    db = _db()
    with db:
        cur = db.execute(
            "DELETE FROM notes WHERE id = ? AND (owner = ? OR ? = 'owner')", (id, u.id, u.role)
        )
    if cur.rowcount == 0:
        raise HttpError(404, f"no note {id} of yours")
    return {"removed": id}
```

- **Who calls comes only from `zenera.identity()`**, never from the page: no
  `user_id` or `role` argument. Anything the page sends, a user can change.
- Store `.id` (an `owner` column), never the email or name: those can change.
- Check permissions in the function (`HttpError(403, ...)`); hiding a button
  in the page is not a check.
- In the page: `const me = await api('api/users').me();`, then show
  `me.name` in the header, and hide what `me.role` may not do.
- When it matters: a page in a chat's workspace already belongs to one user
  (each has their own copy and `.data`). Identity matters for data shared
  between users: an external database, or a page published in the project's
  assets.
- Testing from the shell: your commands already run as the chat's user. To
  try another one, set the variables for one command:
  `ZEN_USER_ID=u2 ZEN_USER_ROLE=viewer python3 -m zenera.api api/notes.api.py my_notes`.

## Calling them from the page

- Copy `/skills/html-page/assets/api.js` beside the page and load it once,
  **by a relative path**: `<script src="api.js"></script>` (from a page in a
  subfolder: `../api.js`). Never edit it.
- `api('<path to the file, relative to the page, without .api.py>')` gives an
  object whose methods are the file's functions:
  `api('api/orders').set_status({ id: 7, status: 'paid' })`.
- Always pass **one object** of named arguments (or nothing). Each call
  returns a promise of what the function returned.
- A failure rejects with an `ApiError`: `.message` is the `HttpError`
  message, `.status` the HTTP status (0: not reachable). Show the message on
  the page.
- After a change, load the data again from the function that lists it, so
  the page shows what is really saved. Disable a button while its call runs.
  The app template's `run(work)` does all three.

| JavaScript                                    | Request                       | Python                       |
| --------------------------------------------- | ----------------------------- | ---------------------------- |
| `api('api/orders').list_orders()`             | `POST api/orders/list_orders` | `list_orders()`              |
| `api('api/orders').set_status({id: 7, ...})`  | `POST api/orders/set_status`  | `set_status(id=7, ...)`      |
| `api('../api/users').me()` (page in a folder) | `POST ../api/users/me`        | `me()` in `api/users.api.py` |

A plain link works for reads too: `api/orders/list_orders?status=open`
(arguments as text, converted by their annotations).

## Test before you link it

Run every function from the shell, against a scratch copy of the data:

```sh
cd /workspace/pages/todo
export ZEN_APP_DATA=/tmp/todo-test          # leaves the page's own data alone
python3 -m zenera.api api/items.api.py      # the callable functions and their arguments
python3 -m zenera.api api/items.api.py add_item '{"title": "Milk"}'
python3 -m zenera.api api/items.api.py list_items
python3 -m zenera.api api/items.api.py set_done '{"id": 1, "done": true}'
python3 -m zenera.api api/items.api.py remove_item '{"id": 99}'   # expect: 404: no item 99
rm -rf /tmp/todo-test; unset ZEN_APP_DATA
grep -noE "api\('[^']+'\)" *.html            # each path, + .api.py, must exist relative to the page
```

Every name the page calls must be a function the listing showed, with the
argument names it shows.
