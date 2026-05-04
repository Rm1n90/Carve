# Armin Mehri — mehri.armin@gmail.com
"""YOLO importer.

Parses a YOLO archive (data.yaml + labels/) into a list of AnnotationDraft
dicts. Resolution from class names to project class IDs is the caller's job
(the importer just yields the parsed shape with the source class name).
"""

from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
import re
import zipfile

from carve_api.annotations.models import AnnotationKind

# Zip-bomb / oversized-archive mitigations. Limits apply to uncompressed size
# (the central-directory ``file_size``) before any read is performed.
_MAX_MEMBER_BYTES = 256 * 1024 * 1024  # 256 MiB per file inside the archive
_MAX_TOTAL_UNCOMPRESSED = 4 * 1024 * 1024 * 1024  # 4 GiB total uncompressed


@dataclass
class AnnotationDraft:
    """A parsed annotation, not yet bound to a project class.

    ``image_filename`` is the basename of the asset the annotation refers to
    (the import job matches it against existing Asset rows by ``original_name``).
    ``class_name`` is the source-format class name (resolved against project
    classes case-insensitively by the import job).
    ``geometry`` is in the same JSONB shape as Annotation.geometry (pixel coords).
    """
    image_filename: str
    class_name: str
    kind: AnnotationKind
    geometry: dict


@dataclass
class ParsedArchive:
    """Result of parsing an archive."""
    drafts: list[AnnotationDraft] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    class_names: list[str] = field(default_factory=list)


_DATA_YAML_NAMES_RE = re.compile(
    r"names\s*:\s*\[(.*?)\]", re.DOTALL,
)


def _parse_yaml_names(yaml_text: str) -> list[str]:
    """Lightweight extraction of the ``names:`` list from a YOLO data.yaml.

    We don't pull in PyYAML — YOLO data.yaml shapes vary and a regex on the
    inline list form is enough for the formats we write (and for vanilla
    Ultralytics exports). Falls back to an empty list when the line is absent.
    """
    m = _DATA_YAML_NAMES_RE.search(yaml_text)
    if not m:
        # Try the multi-line form: names:\n  0: car\n  1: truck
        names: dict[int, str] = {}
        in_block = False
        for line in yaml_text.splitlines():
            stripped = line.rstrip()
            if not in_block:
                if stripped.strip() == "names:":
                    in_block = True
                continue
            if in_block:
                if not stripped.startswith(" "):
                    break  # left the block
                m2 = re.match(r"^\s+(\d+)\s*:\s*(.+?)\s*$", stripped)
                if m2:
                    names[int(m2.group(1))] = m2.group(2).strip().strip('"\'')
                else:
                    break
        if names:
            return [names[k] for k in sorted(names)]
        return []
    inside = m.group(1)
    return [n.strip().strip('"\'') for n in inside.split(",") if n.strip()]


def _parse_label_line(line: str) -> tuple[int, list[float]]:
    parts = line.strip().split()
    if not parts:
        raise ValueError("empty line")
    try:
        idx = int(parts[0])
    except ValueError as exc:
        raise ValueError(f"first token is not an integer: {parts[0]!r}") from exc
    floats = [float(p) for p in parts[1:]]
    return idx, floats


def _draft_from_label_line(
    line: str,
    *,
    image_filename: str,
    class_names: list[str],
    image_w: int,
    image_h: int,
) -> AnnotationDraft | str:
    """Parse one YOLO line; return a draft on success or a warning string on failure."""
    try:
        idx, floats = _parse_label_line(line)
    except ValueError as exc:
        return f"{image_filename}: {exc}"

    if idx < 0 or idx >= len(class_names):
        return f"{image_filename}: class index {idx} out of range (have {len(class_names)} classes)"
    cls_name = class_names[idx]

    if len(floats) == 0:
        # Tag-only line — single class index, no geometry
        return AnnotationDraft(
            image_filename=image_filename,
            class_name=cls_name,
            kind=AnnotationKind.tag,
            geometry={"kind": "tag"},
        )
    if len(floats) == 4:
        # bbox: cx cy w h (normalized)
        cx, cy, w_n, h_n = floats
        x = (cx - w_n / 2.0) * image_w
        y = (cy - h_n / 2.0) * image_h
        return AnnotationDraft(
            image_filename=image_filename,
            class_name=cls_name,
            kind=AnnotationKind.bbox,
            geometry={
                "kind": "bbox",
                "x": x,
                "y": y,
                "w": w_n * image_w,
                "h": h_n * image_h,
            },
        )
    # Polygon: even number ≥ 6 floats
    if len(floats) % 2 != 0:
        return f"{image_filename}: polygon needs even number of coords, got {len(floats)}"
    if len(floats) < 6:
        return f"{image_filename}: polygon needs ≥3 points, got {len(floats) // 2}"
    points = [
        [floats[2 * i] * image_w, floats[2 * i + 1] * image_h]
        for i in range(len(floats) // 2)
    ]
    return AnnotationDraft(
        image_filename=image_filename,
        class_name=cls_name,
        kind=AnnotationKind.polygon,
        geometry={"kind": "polygon", "points": points},
    )


def parse_yolo_archive(
    archive_bytes: bytes,
    *,
    image_dimensions: dict[str, tuple[int, int]] | None = None,
    fallback_class_names: list[str] | None = None,
) -> ParsedArchive:
    """Parse a YOLO ZIP archive.

    The archive must contain per-image ``.txt`` label files (anywhere
    inside the archive — typically under ``labels/`` or
    ``training_data/``). If a ``data.yaml`` (or any ``.yaml``) is
    present with a ``names:`` entry it is used for class names;
    otherwise ``fallback_class_names`` is used (Plan-20.5 — usually
    the project's classes ordered by ``idx``, so a loose-``.txt``
    upload still resolves indices to names).

    ``image_dimensions`` maps the image basename (matching the .txt basename)
    to ``(width, height)``. Drafts default to ``image_w=image_h=0`` if the
    dimensions are not provided, which means coordinates remain in normalised
    space — the import job will multiply through once it knows the matched
    asset's dimensions.
    """
    out = ParsedArchive()
    image_dimensions = image_dimensions or {}
    try:
        zf = zipfile.ZipFile(BytesIO(archive_bytes))
    except zipfile.BadZipFile as exc:
        raise ValueError(f"not a valid zip archive: {exc}") from exc

    yaml_text = ""
    label_members: list[zipfile.ZipInfo] = []
    total_uncompressed = 0
    with zf:
        for member in zf.infolist():
            if member.is_dir():
                continue
            # Per-member zip-bomb guard: bail before reading if the central-directory
            # uncompressed size already exceeds the cap.
            if member.file_size > _MAX_MEMBER_BYTES:
                raise ValueError("import_archive_member_too_large")
            name_lower = member.filename.lower()
            if name_lower.endswith(".yaml") or name_lower.endswith(".yml"):
                if not yaml_text:
                    total_uncompressed += member.file_size
                    if total_uncompressed > _MAX_TOTAL_UNCOMPRESSED:
                        raise ValueError("import_archive_too_large")
                    yaml_text = zf.read(member).decode("utf-8", errors="replace")
            elif name_lower.endswith(".txt"):
                label_members.append(member)

        if yaml_text:
            out.class_names = _parse_yaml_names(yaml_text)
        if not out.class_names and fallback_class_names:
            out.class_names = list(fallback_class_names)
        if not out.class_names:
            out.warnings.append(
                "no data.yaml or class-name fallback provided; class indices will fail to resolve",
            )

        for member in label_members:
            total_uncompressed += member.file_size
            if total_uncompressed > _MAX_TOTAL_UNCOMPRESSED:
                raise ValueError("import_archive_too_large")
            stem = Path(member.filename).stem
            # Try several common image basename forms when matching dimensions
            dims = (
                image_dimensions.get(stem)
                or image_dimensions.get(f"{stem}.png")
                or image_dimensions.get(f"{stem}.jpg")
                or image_dimensions.get(f"{stem}.jpeg")
                or image_dimensions.get(f"{stem}.webp")
            )
            image_w, image_h = dims if dims else (1, 1)
            data = zf.read(member).decode("utf-8", errors="replace")
            for line in data.splitlines():
                if not line.strip():
                    continue
                result = _draft_from_label_line(
                    line,
                    image_filename=stem,
                    class_names=out.class_names,
                    image_w=image_w,
                    image_h=image_h,
                )
                if isinstance(result, str):
                    out.warnings.append(result)
                else:
                    out.drafts.append(result)

    return out
