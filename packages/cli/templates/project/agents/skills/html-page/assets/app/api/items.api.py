"""The app's API: every public function here can be called from index.html.

    const items = api('api/items');
    await items.add_item({ title: 'Milk' })   ->   add_item(title="Milk")

Names starting with `_` and anything imported are not callable from the page.
Try them from a shell before linking the app:

    python3 -m zenera.api api/items.api.py
    python3 -m zenera.api api/items.api.py add_item '{"title": "Milk"}'
"""

import zenera
from zenera.api import HttpError, connect


def _db():
    db = connect("app.sqlite")
    db.execute(
        """CREATE TABLE IF NOT EXISTS items (
            id      INTEGER PRIMARY KEY,
            title   TEXT    NOT NULL,
            done    INTEGER NOT NULL DEFAULT 0,
            created TEXT    NOT NULL DEFAULT (datetime('now'))
        )"""
    )
    return db


def _item(db, item_id: int):
    row = db.execute("SELECT id, title, done, created FROM items WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        raise HttpError(404, f"no item {item_id}")
    return {**row, "done": bool(row["done"])}


def me():
    """Who is using the page, for its header; None when nobody is signed in."""
    u = zenera.identity()
    if u is None:
        return None
    return {"id": u.id, "name": u.name or u.email or u.id, "role": u.role}


def list_items(show: str = "all"):
    """All items, or only the open or done ones (show: all | open | done)."""
    where = {"all": "", "open": " WHERE done = 0", "done": " WHERE done = 1"}
    if show not in where:
        raise HttpError(400, "show must be all, open or done")
    rows = _db().execute(f"SELECT id, title, done, created FROM items{where[show]} ORDER BY id").fetchall()
    return [{**r, "done": bool(r["done"])} for r in rows]


def add_item(title: str):
    """Adds an item and returns it."""
    title = (title or "").strip()
    if not title:
        raise HttpError(400, "the title is empty")
    if len(title) > 200:
        raise HttpError(400, "the title is longer than 200 characters")
    db = _db()
    with db:
        cur = db.execute("INSERT INTO items (title) VALUES (?)", (title,))
    return _item(db, cur.lastrowid)


def set_done(id: int, done: bool):
    """Marks an item done or open, and returns it."""
    db = _db()
    with db:
        cur = db.execute("UPDATE items SET done = ? WHERE id = ?", (1 if done else 0, id))
    if cur.rowcount == 0:
        raise HttpError(404, f"no item {id}")
    return _item(db, id)


def remove_item(id: int):
    """Deletes an item."""
    db = _db()
    with db:
        cur = db.execute("DELETE FROM items WHERE id = ?", (id,))
    if cur.rowcount == 0:
        raise HttpError(404, f"no item {id}")
    return {"removed": id}
