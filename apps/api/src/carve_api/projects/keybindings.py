"""Service helpers for class digit-shortcut keybindings.

The composition rules implement the spec's "stored ∪ computed seed"
contract:

  1. Stored rows in ``class_keybindings`` take precedence.
  2. Empty digits fall back to ``class.idx ASC LIMIT 9``, skipping
     classes already bound by a stored row.

Mutation helpers enforce the "move-not-duplicate" invariant: re-binding
a class to a different digit DELETES the prior row in the same
transaction. The UNIQUE (user_id, project_id, class_id) constraint
catches any concurrent violation.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from carve_api.projects.models import Class, ClassKeybinding


@dataclass(frozen=True)
class EffectiveBinding:
    digit: int
    class_id: uuid.UUID
    source: Literal["stored", "seed"]


def compose_effective_bindings(
    db: Session,
    *,
    user_id: uuid.UUID,
    project_id: uuid.UUID,
) -> list[EffectiveBinding]:
    """Return the user's effective bindings for this project, with
    stored rows taking precedence over the idx-ASC seed."""
    stored_rows = db.execute(
        select(ClassKeybinding)
        .where(
            ClassKeybinding.user_id == user_id,
            ClassKeybinding.project_id == project_id,
        )
        .order_by(ClassKeybinding.digit.asc())
    ).scalars().all()
    stored_by_digit: dict[int, ClassKeybinding] = {
        r.digit: r for r in stored_rows
    }
    stored_class_ids: set[uuid.UUID] = {r.class_id for r in stored_rows}

    seed_candidates = db.execute(
        select(Class)
        .where(Class.project_id == project_id)
        .order_by(Class.idx.asc())
    ).scalars().all()
    # Drop classes already bound by a stored row so no duplicate badge.
    seed_pool = [c for c in seed_candidates if c.id not in stored_class_ids]

    out: list[EffectiveBinding] = []
    seed_iter = iter(seed_pool)
    for digit in range(1, 10):
        stored = stored_by_digit.get(digit)
        if stored is not None:
            out.append(EffectiveBinding(
                digit=digit, class_id=stored.class_id, source="stored",
            ))
            continue
        try:
            seed_class = next(seed_iter)
        except StopIteration:
            # Fewer than 9 unbound classes — this digit is empty.
            continue
        out.append(EffectiveBinding(
            digit=digit, class_id=seed_class.id, source="seed",
        ))
    return out


def set_binding(
    db: Session,
    *,
    user_id: uuid.UUID,
    project_id: uuid.UUID,
    digit: int,
    class_id: uuid.UUID,
) -> ClassKeybinding:
    """Create or move a binding.

    If the class is already bound at a different digit, that row is
    deleted in the same transaction (move-not-duplicate). If the digit
    is already bound to a different class, that row is replaced. The
    caller commits; this helper only stages.
    """
    if digit < 1 or digit > 9:
        raise ValueError(f"digit out of range: {digit}")
    # 1. Remove the class's prior binding at any other digit.
    db.execute(
        delete(ClassKeybinding)
        .where(
            ClassKeybinding.user_id == user_id,
            ClassKeybinding.project_id == project_id,
            ClassKeybinding.class_id == class_id,
            ClassKeybinding.digit != digit,
        )
    )
    # 2. Remove any prior binding at this digit (different class).
    db.execute(
        delete(ClassKeybinding)
        .where(
            ClassKeybinding.user_id == user_id,
            ClassKeybinding.project_id == project_id,
            ClassKeybinding.digit == digit,
        )
    )
    # 3. Insert the new row.
    row = ClassKeybinding(
        user_id=user_id,
        project_id=project_id,
        digit=digit,
        class_id=class_id,
    )
    db.add(row)
    return row


def delete_binding(
    db: Session,
    *,
    user_id: uuid.UUID,
    project_id: uuid.UUID,
    digit: int,
) -> None:
    """Idempotent — silently no-ops when no row exists."""
    db.execute(
        delete(ClassKeybinding)
        .where(
            ClassKeybinding.user_id == user_id,
            ClassKeybinding.project_id == project_id,
            ClassKeybinding.digit == digit,
        )
    )
