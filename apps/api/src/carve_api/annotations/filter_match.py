# Armin Mehri — mehri.armin@gmail.com
"""Which assets of a task hold an annotation that matches the editor's filter.

The editor's arrow keys stop only on those assets. The filter is the rule
tree of ``apps/web/src/lib/annotation-filter.ts``; it is evaluated here in
SQL with the same semantics, so a task of any size answers with its asset
ids instead of sending every annotation to the browser (900k of them in a
large task, which the API cannot hold in memory at once).

Semantics kept from the client evaluator:

* a rule with an empty value matches everything;
* labels, kinds and ids compare case-insensitively, as text;
* numeric fields compare as numbers, and a rule value that is not a
  number matches nothing;
* a field that cannot be computed (a score on a box a person drew)
  fails the rule, so a negated rule passes;
* width and height are the bounding rect of the geometry (a mask's are
  its canvas size, a tag's are 0);
* a mask's kind reads ``mask_rle``, the value the filter dialog offers.
"""

from __future__ import annotations

import math
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

FilterField = Literal["label", "kind", "width", "height", "obj_id", "confidence", "visible"]
FilterOp = Literal["==", "!=", "<", ">", "<=", ">="]

# Bounds on a tree, so a request cannot build an unbounded query.
MAX_DEPTH = 8
MAX_NODES = 200


class FilterRule(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    negate: bool = Field(default=False, alias="not")
    field: FilterField
    op: FilterOp
    value: str | int | float | None = None


class FilterGroup(BaseModel):
    combinator: Literal["AND", "OR"]
    rules: list[FilterGroup | FilterRule] = Field(default_factory=list)


FilterGroup.model_rebuild()


class FilterTooLarge(ValueError):
    pass


_NUMERIC = {"width", "height", "confidence", "visible"}

_SQL_OP = {"==": "=", "!=": "<>", "<": "<", ">": ">", "<=": "<=", ">=": ">="}


def _extent(axis: int) -> str:
    """Bounding-rect extent along x (axis 0) or y (axis 1)."""
    box_side = "w" if axis == 0 else "h"
    mask_dim = 1 - axis  # a mask's size is [height, width]
    # Fixed SQL: no input reaches these fragments.
    polygon = (
        f"coalesce((select max((p->>{axis})::float) - min((p->>{axis})::float)"  # noqa: S608
        " from jsonb_array_elements(a.geometry->'points') p), 0)"
    )
    return (
        f"(case a.kind when 'bbox' then (a.geometry->>'{box_side}')::float"
        f" when 'polygon' then {polygon}"
        f" when 'mask' then (a.geometry->'size'->>{mask_dim})::float else 0 end)"
    )


_FIELD_SQL = {
    "label": "lower(coalesce(c.name, ''))",
    "kind": "(case when a.kind = 'mask' then 'mask_rle' else a.kind::text end)",
    "obj_id": "lower(a.id::text)",
    "confidence": "a.confidence",
    # A scored box with no visibility figure is taken as fully in view.
    "visible": "(case when a.confidence is null then null else coalesce(a.visible, 100) end)",
    "width": _extent(0),
    "height": _extent(1),
}


def _js_string(value: str | int | float) -> str:
    """The rule value as JavaScript's ``String()`` writes it."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _number(value: str | int | float) -> float | None:
    """The rule value as JavaScript's ``Number()`` reads it, or None."""
    if isinstance(value, int | float):
        out = float(value)
    else:
        s = value.strip()
        if s == "":
            return 0.0
        try:
            out = float(s)
        except ValueError:
            return None
    return None if math.isnan(out) else out


class _Compiler:
    def __init__(self) -> None:
        self.params: dict[str, object] = {}
        self.nodes = 0

    def _param(self, value: object) -> str:
        name = f"p{len(self.params)}"
        self.params[name] = value
        return f":{name}"

    def rule(self, r: FilterRule) -> str:
        if r.value is None or r.value == "":
            return "true"
        field = _FIELD_SQL[r.field]
        op = _SQL_OP[r.op]
        if r.field in _NUMERIC:
            n = _number(r.value)
            matched = "false" if n is None else f"({field} {op} {self._param(n)})"
            when_matched = f"not {matched}" if r.negate else matched
            missing = "true" if r.negate else "false"
            return f"(case when {field} is null then {missing} else {when_matched} end)"
        rhs = f"lower({self._param(_js_string(r.value))})"
        if r.op in ("==", "!="):
            matched = f"({field} {op} {rhs})"
        else:
            # JavaScript orders strings by code unit, like the C collation.
            matched = f'({field} collate "C" {op} {rhs} collate "C")'
        return f"(not {matched})" if r.negate else matched

    def group(self, g: FilterGroup, depth: int = 0) -> str:
        if depth > MAX_DEPTH:
            raise FilterTooLarge("filter nests too deeply")
        if not g.rules:
            return "true"
        parts = []
        for node in g.rules:
            self.nodes += 1
            if self.nodes > MAX_NODES:
                raise FilterTooLarge("filter has too many rules")
            parts.append(
                self.group(node, depth + 1) if isinstance(node, FilterGroup) else self.rule(node)
            )
        joiner = " and " if g.combinator == "AND" else " or "
        return "(" + joiner.join(parts) + ")"


def compile_filter(group: FilterGroup) -> tuple[str, dict[str, object]]:
    """The filter as a SQL condition on ``annotations a`` / ``classes c``."""
    c = _Compiler()
    return c.group(group), c.params


def matching_asset_ids(session: Session, task_id: uuid.UUID, group: FilterGroup) -> list[str]:
    """The ids of the task's assets with at least one matching annotation."""
    where, params = compile_filter(group)
    # Only fixed fragments are joined in; every value is a bound parameter.
    sql = (
        "select distinct f.asset_id::text from annotations a"  # noqa: S608
        " join frames f on f.id = a.frame_id"
        " left join classes c on c.id = a.class_id"
        f" where a.task_id = :task_id and {where}"
    )
    return list(session.execute(text(sql), {"task_id": task_id, **params}).scalars())
