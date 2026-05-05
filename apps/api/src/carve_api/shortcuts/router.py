# Armin Mehri -- mehri.armin@gmail.com
"""Per-user keyboard shortcut overrides API.

Endpoints (all auth-gated via ``get_current_user``):

* ``GET    /me/shortcuts`` -- return ``{ "overrides": {...} }``.
* ``PUT    /me/shortcuts`` -- replace the entire override map.
* ``DELETE /me/shortcuts/{action_id}`` -- reset one action.
* ``DELETE /me/shortcuts``  -- reset all (overrides become ``{}``).

Storage: ``users.shortcut_overrides`` JSONB column (migration 0030).
Sparse map; missing key => use the default chord on the client.

Validation:
* ``action_id`` matches ``^[a-z][a-z0-9_]{0,63}$``
* chord matches ``^([a-z]+\\+)*[a-z0-9]+$`` (lowercase modifiers and
  the final keysym; modifiers are ``mod``, ``alt``, ``shift``).
* an empty string is reserved for "unbound" -- the client keeps the
  handler registered but never fires it. v1 does not expose this in
  the UI but the API accepts it for forward compatibility.
* total entries capped at ``MAX_OVERRIDES`` to prevent abuse.

The PUT endpoint replaces the entire dict (the frontend always knows
the full state). The DELETE endpoints are convenience helpers so the
"Reset to default" buttons in the settings page don't need to round
trip through a full PUT.
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db


router = APIRouter(prefix="/me/shortcuts", tags=["shortcuts"])

# Action ids are short, lowercase, snake_case identifiers. The 64-char
# cap (1 + 63 trailing) leaves headroom for a meaningful, namespaced
# action name without inviting abuse.
ACTION_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

# Chord format: lowercase tokens joined by ``+``. Optional modifier
# tokens precede a single keysym. Modifiers and keysyms share the same
# alpha-num character class because the wire format is intentionally
# permissive about future keysym names (e.g. ``f12``, ``slash``,
# ``arrowleft``); the validator below additionally constrains the
# modifier set so callers can't smuggle in a fourth modifier.
CHORD_RE = re.compile(r"^([a-z]+\+)*[a-z0-9]+$")
ALLOWED_MODIFIERS = frozenset({"mod", "alt", "shift"})

# Hard cap on the override map size. Two hundred is comfortably above
# the v1 action catalog (~16) and well below "abuse the JSONB column".
MAX_OVERRIDES = 200


def _validate_chord(chord: str) -> None:
    """Raise HTTPException 422 if the chord is malformed."""
    # Empty string is the "unbound" sentinel; allow it through.
    if chord == "":
        return
    if not CHORD_RE.match(chord):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"invalid chord: {chord!r}",
        )
    parts = chord.split("+")
    # All but the last token must be a known modifier; the last token
    # is the keysym (a letter, digit, or named special key).
    for mod in parts[:-1]:
        if mod not in ALLOWED_MODIFIERS:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"unknown modifier {mod!r} in chord {chord!r}",
            )
    # Reject duplicate modifiers (e.g. "mod+mod+a") so the wire format
    # stays canonical.
    if len(parts[:-1]) != len(set(parts[:-1])):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"duplicate modifier in chord {chord!r}",
        )


def _validate_action_id(action_id: str) -> None:
    if not ACTION_ID_RE.match(action_id):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"invalid action_id: {action_id!r}",
        )


class ShortcutOverrides(BaseModel):
    """Wire shape for the GET / PUT bodies.

    The wrapping ``overrides`` object leaves room for sibling metadata
    in future revisions (e.g. ``profile_id`` for shared layouts) without
    a wire-incompatible change.
    """

    overrides: dict[str, str] = Field(default_factory=dict)

    @field_validator("overrides")
    @classmethod
    def _validate_overrides(cls, v: dict[str, str]) -> dict[str, str]:
        if len(v) > MAX_OVERRIDES:
            raise ValueError(
                f"too many overrides: {len(v)} (max {MAX_OVERRIDES})"
            )
        return v


def _persist_overrides(
    db: Session, user: User, overrides: dict[str, str]
) -> dict[str, str]:
    user.shortcut_overrides = overrides
    # JSONB columns need an explicit "yes this changed" hint when the
    # value is replaced wholesale; flag_modified is the supported way.
    flag_modified(user, "shortcut_overrides")
    db.add(user)
    db.commit()
    db.refresh(user)
    return dict(user.shortcut_overrides or {})


@router.get("", response_model=ShortcutOverrides)
def get_shortcuts(
    user: User = Depends(get_current_user),
) -> ShortcutOverrides:
    return ShortcutOverrides(overrides=dict(user.shortcut_overrides or {}))


@router.put("", response_model=ShortcutOverrides)
def put_shortcuts(
    body: ShortcutOverrides,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ShortcutOverrides:
    # Validate every entry up front so a single bad row aborts the
    # request without a partial write.
    for action_id, chord in body.overrides.items():
        _validate_action_id(action_id)
        _validate_chord(chord)
    saved = _persist_overrides(db, user, dict(body.overrides))
    return ShortcutOverrides(overrides=saved)


@router.delete("/{action_id}", response_model=ShortcutOverrides)
def reset_one(
    action_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ShortcutOverrides:
    _validate_action_id(action_id)
    current = dict(user.shortcut_overrides or {})
    if action_id in current:
        current.pop(action_id)
        saved = _persist_overrides(db, user, current)
    else:
        saved = current
    return ShortcutOverrides(overrides=saved)


@router.delete("", response_model=ShortcutOverrides)
def reset_all(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ShortcutOverrides:
    saved = _persist_overrides(db, user, {})
    return ShortcutOverrides(overrides=saved)
