"""Who this Zenera run is acting for.

The host that started the run - Zenera's app, or ``zen run --as`` - puts the
signed-in user into every command's environment as ``ZEN_USER_*``. This module
reads them, so code an agent writes can depend on who is asking::

    import zenera

    me = zenera.identity()          # None when no one is signed in
    if me:
        print(me.id, me.email, me.role)

    me = zenera.require_identity()  # raises when no one is signed in

``source`` is ``"host"`` when the application authenticated the user and
``"local"`` when it was only stated on the machine running the project.
Standard library only, so it works in any image with a Python 3.
"""

import os
from typing import NamedTuple, Optional

__all__ = ["Identity", "NoIdentityError", "identity", "require_identity"]


class Identity(NamedTuple):
    id: str
    email: Optional[str] = None
    name: Optional[str] = None
    role: Optional[str] = None
    source: str = "local"


class NoIdentityError(RuntimeError):
    """Raised by require_identity() when the run has no signed-in user."""


def _get(name: str) -> Optional[str]:
    value = os.environ.get(name, "").strip()
    return value or None


def identity() -> Optional[Identity]:
    """The signed-in user this run acts for, or None when there is none."""
    user_id = _get("ZEN_USER_ID")
    if not user_id:
        return None
    return Identity(
        id=user_id,
        email=_get("ZEN_USER_EMAIL"),
        name=_get("ZEN_USER_NAME"),
        role=_get("ZEN_USER_ROLE"),
        source=_get("ZEN_USER_SOURCE") or "local",
    )


def require_identity() -> Identity:
    """The signed-in user this run acts for; raises NoIdentityError when there is none."""
    me = identity()
    if me is None:
        raise NoIdentityError(
            "this run has no signed-in user (ZEN_USER_ID is not set); "
            "outside the Zenera app, start it with: zen run --as <user>"
        )
    return me
