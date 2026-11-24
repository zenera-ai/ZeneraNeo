"""The functions an html app's page calls: a ``<name>.api.py`` beside the page.

Every public function defined in such a file (a name not starting with ``_``)
can be called by the page's JavaScript, by a URL relative to the page, with
its arguments as a JSON object::

    # api/orders.api.py
    from zenera.api import HttpError, connect

    def list_orders(status: str = "open"):
        return connect().execute(
            "SELECT * FROM orders WHERE status = ?", (status,)
        ).fetchall()

    POST api/orders/list_orders   {"status": "open"}  ->  list_orders(status="open")
    GET  api/orders/list_orders?status=open            ->  the same

What a function returns is the JSON the page gets: dicts, lists, numbers,
strings, None, and also dates (ISO strings), Decimals and dataclasses.
``raise HttpError(404, "no such order")`` answers with that status and
``{"error": "no such order"}``; any other exception is a 500.

Each call is a process of its own: nothing kept in a variable survives to the
next one. Keep data with ``connect()`` (SQLite) or ``data_path()``, in the
``.data`` folder beside the file, which the page cannot download.

How a host runs one call (zen server, Zenera's app)::

    python3 -m zenera.api --serve orders.api.py  < request.json

The request is ``{"method", "path": "/<function>", "query": {name: value},
"headers": {...}, "body": <JSON, or the raw text of it>}`` and one JSON
envelope ``{"status", "headers", "body"}`` is written to stdout; what the
functions print goes to stderr, the log. To try a file from a shell::

    python3 -m zenera.api api/orders.api.py                      # its functions
    python3 -m zenera.api api/orders.api.py list_orders '{"status": "open"}'

Standard library only, so it works in any image with a Python 3.8 or later.
"""

import asyncio
import dataclasses
import datetime
import decimal
import importlib.util
import inspect
import json
import math
import os
import re
import sqlite3
import sys
import traceback
from typing import Any, Callable, Dict, Optional

__all__ = [
    "HttpError",
    "Request",
    "Response",
    "connect",
    "data_path",
    "functions",
    "main",
    "request",
]

SUFFIX = ".api.py"
DATA_ENV = "ZEN_APP_DATA"


class HttpError(Exception):
    """Raise to answer with ``status`` and ``{"error": message}``."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = int(status)
        self.message = message


class Response:
    """Return one to choose the status or headers: ``Response(order, status=201)``."""

    def __init__(self, body: Any = None, status: int = 200, headers: Optional[Dict[str, str]] = None):
        self.body = body
        self.status = int(status)
        self.headers = dict(headers or {})


class Request:
    """The call being answered, from ``request()``."""

    def __init__(self, method: str, function: str, query: Dict[str, Any], headers: Dict[str, str], body: Any):
        self.method = method
        self.function = function
        self.query = query
        self.headers = headers
        self.body = body


_current: Optional[Request] = None
_api_dir: Optional[str] = None


def request() -> Request:
    """The call being answered; only while a function of an .api.py runs."""
    if _current is None:
        raise RuntimeError("zenera.api.request() is only known while a call is answered")
    return _current


def data_path(name: str = "") -> str:
    """Where the app keeps ``name``: in ``.data`` beside the .api.py, or ``$ZEN_APP_DATA``."""
    if name and (os.path.isabs(name) or ".." in re.split(r"[\\/]", name)):
        raise ValueError(f"data_path: {name!r} must be a name inside the data folder")
    base = os.environ.get(DATA_ENV) or os.path.join(_api_dir or os.getcwd(), ".data")
    os.makedirs(base, exist_ok=True)
    path = os.path.join(base, name) if name else base
    if name:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def _dict_row(cursor: sqlite3.Cursor, row: tuple) -> Dict[str, Any]:
    return {d[0]: v for d, v in zip(cursor.description, row)}


def connect(name: str = "app.sqlite") -> sqlite3.Connection:
    """The app's SQLite database, made when first used. Rows come back as dicts.

    Changes are kept by ``with db:`` (commits, or rolls back on an exception).
    WAL and a busy timeout let several calls and the agent use it at once.
    """
    db = sqlite3.connect(data_path(name), timeout=10)
    db.row_factory = _dict_row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=10000")
    return db


def functions(module: Any) -> Dict[str, Callable[..., Any]]:
    """The functions a page may call: public, and defined in the file itself, not imported."""
    found = {}
    for name, value in vars(module).items():
        if name.startswith("_") or not inspect.isfunction(value):
            continue
        if value.__module__ == module.__name__:
            found[name] = value
    return found


def load(path: str) -> Any:
    """Imports an .api.py, with its own folder first on ``sys.path`` for its helpers."""
    global _api_dir
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"no such file: {path}")
    folder = os.path.dirname(path)
    _api_dir = folder
    if folder not in sys.path:
        sys.path.insert(0, folder)
    base = os.path.basename(path)
    stem = base[: -len(SUFFIX)] if base.endswith(SUFFIX) else os.path.splitext(base)[0]
    name = "_zenera_api_" + re.sub(r"\W", "_", stem)
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off", ""}


def _convert(value: Any, annotation: Any, name: str) -> Any:
    """An argument as the type its parameter is annotated with (int, float, bool, str), or a 400.

    Query values are text and are parsed; JSON values must already be of the type, except
    that a whole float is an int and 0/1 a bool. None passes: a default of None means optional.
    """
    kind = annotation if isinstance(annotation, str) else getattr(annotation, "__name__", None)
    if value is None or kind not in ("int", "float", "bool", "str"):
        return value
    what = {"int": "a whole number", "float": "a number", "bool": "true or false", "str": "text"}[kind]
    bad = HttpError(400, f"{name} must be {what}, not {json.dumps(value)[:80]}")
    if kind == "str":
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            raise bad
        return value if isinstance(value, str) else str(value)
    if kind == "bool":
        if isinstance(value, bool):
            return value
        if isinstance(value, int) and value in (0, 1):
            return bool(value)
        if isinstance(value, str):
            low = value.strip().lower()
            if low in _TRUE:
                return True
            if low in _FALSE:
                return False
        raise bad
    if isinstance(value, bool):
        raise bad
    if isinstance(value, str):
        try:
            return int(value) if kind == "int" else float(value)
        except ValueError:
            raise bad from None
    if kind == "int":
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
        raise bad
    if isinstance(value, (int, float)):
        return float(value)
    raise bad


def _arguments(fn: Callable[..., Any], query: Dict[str, Any], body: Any) -> Dict[str, Any]:
    params = inspect.signature(fn).parameters
    args = dict(query)
    if body is not None and body != "":
        if isinstance(body, str):
            # The page sends its JSON as text/plain (no CORS preflight), so hosts pass it on as is.
            try:
                body = json.loads(body)
            except ValueError:
                raise HttpError(400, "the arguments are not JSON: send them as a JSON object") from None
        if not isinstance(body, dict):
            raise HttpError(400, "send the arguments as a JSON object: {\"name\": value}")
        args.update(body)
    for name, value in args.items():
        param = params.get(name)
        if param is not None:
            args[name] = _convert(value, param.annotation, name)
    return args


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return _jsonable(dataclasses.asdict(value))
    if isinstance(value, sqlite3.Row):
        return {k: _jsonable(value[k]) for k in value.keys()}
    if isinstance(value, (bytes, bytearray)):
        raise TypeError("bytes cannot be sent as JSON: write a file with data_path() and return its name")
    if hasattr(value, "_asdict"):
        return _jsonable(value._asdict())
    raise TypeError(f"a {type(value).__name__} cannot be sent as JSON")


def _error(status: int, message: str) -> Dict[str, Any]:
    return {"status": status, "headers": {}, "body": {"error": message}}


def _query(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    # A name given twice is a list from the host; one value is what a parameter takes.
    return {str(k): (v[-1] if isinstance(v, list) and v else v) for k, v in raw.items()}


def answer(module: Any, req: Dict[str, Any], file: str = "the api") -> Dict[str, Any]:
    """One call, as the envelope a host sends back."""
    global _current
    method = str(req.get("method") or "POST").upper()
    path = str(req.get("path") or "/").strip("/")
    callable_ = functions(module)
    if not path or "/" in path:
        names = ", ".join(sorted(callable_)) or "none"
        return _error(404, f"name a function of {file}: {names}")
    fn = callable_.get(path)
    if fn is None:
        names = ", ".join(sorted(callable_)) or "none"
        return _error(404, f"{file} has no function {path!r}; it has: {names}")
    headers = req.get("headers") if isinstance(req.get("headers"), dict) else {}
    body = req.get("body")
    _current = Request(method, path, _query(req.get("query")), headers, body)
    try:
        args = _arguments(fn, _current.query, None if method in ("GET", "HEAD") else body)
        try:
            bound = inspect.signature(fn).bind(**args)
        except TypeError as err:
            raise HttpError(400, f"{path}: {err}") from None
        result = fn(*bound.args, **bound.kwargs)
        if inspect.isawaitable(result):
            result = asyncio.run(result)
        status, extra = 200, {}
        if isinstance(result, Response):
            status, extra, result = result.status, result.headers, result.body
        return {"status": status, "headers": extra, "body": _jsonable(result)}
    except HttpError as err:
        return _error(err.status, err.message)
    except Exception as err:  # the page gets a 500; the log keeps the traceback
        traceback.print_exc()
        return _error(500, f"{path} failed: {type(err).__name__}: {err}")
    finally:
        _current = None


def _serve(file: str) -> int:
    out = sys.stdout
    sys.stdout = sys.stderr
    try:
        try:
            req = json.load(sys.stdin)
            if not isinstance(req, dict):
                raise ValueError("the request is not a JSON object")
        except ValueError as err:
            envelope = _error(400, f"bad request: {err}")
        else:
            try:
                module = load(file)
            except Exception as err:
                traceback.print_exc()
                envelope = _error(500, f"{os.path.basename(file)} failed to load: {type(err).__name__}: {err}")
            else:
                envelope = answer(module, req, os.path.basename(file))
    finally:
        sys.stdout = out
    out.write(json.dumps(envelope, ensure_ascii=False, allow_nan=False))
    out.write("\n")
    out.flush()
    return 0


def _signature(name: str, fn: Callable[..., Any]) -> str:
    doc = (inspect.getdoc(fn) or "").split("\n", 1)[0]
    line = f"{name}{inspect.signature(fn)}"
    return f"{line}  - {doc}" if doc else line


def _try(file: str, name: Optional[str], raw: Optional[str]) -> int:
    out = sys.stdout
    sys.stdout = sys.stderr
    try:
        module = load(file)
        if name is None:
            listed = functions(module)
            lines = [_signature(n, f) for n, f in sorted(listed.items())]
            text = "\n".join(lines) if lines else f"{os.path.basename(file)} has no public functions"
            out.write(text + "\n")
            return 0
        try:
            body = json.loads(raw) if raw else {}
        except ValueError as err:
            print(f"the arguments are not JSON: {err}", file=sys.stderr)
            return 2
        envelope = answer(module, {"method": "POST", "path": f"/{name}", "body": body}, os.path.basename(file))
    finally:
        sys.stdout = out
    if envelope["status"] >= 400:
        print(f"{envelope['status']}: {envelope['body']['error']}", file=sys.stderr)
        return 1
    out.write(json.dumps(envelope["body"], ensure_ascii=False, indent=2) + "\n")
    return 0


USAGE = """usage:
  python3 -m zenera.api FILE.api.py                       list the functions a page can call
  python3 -m zenera.api FILE.api.py FUNCTION ['{json}']   call one, print what it returns
  python3 -m zenera.api --serve FILE.api.py               answer the request on stdin (hosts)"""


def main(argv: Optional[list] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] == "--serve":
        if len(args) != 2:
            print(USAGE, file=sys.stderr)
            return 2
        return _serve(args[1])
    if not args or args[0] in ("-h", "--help") or len(args) > 3:
        print(USAGE, file=sys.stderr)
        return 0 if args and args[0] in ("-h", "--help") else 2
    return _try(args[0], args[1] if len(args) > 1 else None, args[2] if len(args) > 2 else None)


if __name__ == "__main__":
    # Run as the imported module, so an .api.py's `from zenera.api import HttpError` is this
    # very class and not a second copy living in __main__.
    from zenera import api as _api

    sys.exit(_api.main())
