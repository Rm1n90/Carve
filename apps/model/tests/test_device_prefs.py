"""Persistence + roundtrip tests for carve_model.device_prefs."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from carve_model import device_prefs


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Point persistence at a tmp file per test + start from a clean slate."""
    target = tmp_path / "device_prefs.json"
    monkeypatch.setenv("CARVE_DEVICE_PREFS_PATH", str(target))
    device_prefs._reset_for_tests(path=str(target))
    yield target
    device_prefs._reset_for_tests()


def test_default_is_auto_for_every_kind(isolated: Path) -> None:
    assert device_prefs.get_pref("sam") is None
    assert device_prefs.get_pref("yolo") is None
    assert device_prefs.get_pref("yoloe") is None


def test_set_and_get_roundtrip(isolated: Path) -> None:
    device_prefs.set_pref("yoloe", "cuda:0")
    assert device_prefs.get_pref("yoloe") == "cuda:0"


def test_auto_string_normalises_to_none(isolated: Path) -> None:
    device_prefs.set_pref("sam", "cuda:0")
    device_prefs.set_pref("sam", "auto")
    assert device_prefs.get_pref("sam") is None


def test_blank_string_normalises_to_none(isolated: Path) -> None:
    device_prefs.set_pref("sam", "  ")
    assert device_prefs.get_pref("sam") is None


def test_uppercase_lowered(isolated: Path) -> None:
    device_prefs.set_pref("yolo", "CUDA:1")
    assert device_prefs.get_pref("yolo") == "cuda:1"


def test_unknown_kind_raises(isolated: Path) -> None:
    with pytest.raises(ValueError):
        device_prefs.get_pref("magic")
    with pytest.raises(ValueError):
        device_prefs.set_pref("magic", "cpu")


def test_persists_to_disk(isolated: Path) -> None:
    device_prefs.set_pref("yoloe", "cuda:0")
    device_prefs.set_pref("yolo", "cpu")
    assert isolated.is_file()
    data = json.loads(isolated.read_text())
    assert data["yoloe"] == "cuda:0"
    assert data["yolo"] == "cpu"
    # sam was left at default → null
    assert data["sam"] is None
    assert data["_v"] == 1


def test_reload_after_simulated_restart(isolated: Path) -> None:
    """Simulate a container restart — write prefs, blow away in-memory
    state, re-load from disk."""
    device_prefs.set_pref("sam", "cuda:1")
    device_prefs.set_pref("yoloe", "cpu")

    # Reset in-memory state but keep the file. Then read back.
    device_prefs._reset_for_tests(path=str(isolated))

    assert device_prefs.get_pref("sam") == "cuda:1"
    assert device_prefs.get_pref("yoloe") == "cpu"
    assert device_prefs.get_pref("yolo") is None


def test_corrupt_file_falls_back_to_auto(isolated: Path) -> None:
    isolated.write_text("not json {{{")
    # Force a fresh module-level read with the bad file in place.
    device_prefs._reset_for_tests(path=str(isolated))
    assert device_prefs.get_pref("sam") is None
    assert device_prefs.get_pref("yolo") is None
    assert device_prefs.get_pref("yoloe") is None


def test_extra_keys_ignored(isolated: Path) -> None:
    isolated.write_text(json.dumps({"_v": 1, "sam": "cpu", "rogue": "x"}))
    device_prefs._reset_for_tests(path=str(isolated))
    assert device_prefs.get_pref("sam") == "cpu"


def test_wrong_type_value_treated_as_auto(isolated: Path) -> None:
    isolated.write_text(json.dumps({"sam": 42, "yolo": None, "yoloe": None}))
    device_prefs._reset_for_tests(path=str(isolated))
    assert device_prefs.get_pref("sam") is None


def test_reset_all_clears_and_persists(isolated: Path) -> None:
    device_prefs.set_pref("yoloe", "cuda:0")
    device_prefs.reset_all()
    assert device_prefs.get_pref("yoloe") is None
    # File reflects the reset.
    data = json.loads(isolated.read_text())
    assert data["yoloe"] is None


def test_atomic_write_does_not_leak_tmp_files(isolated: Path) -> None:
    device_prefs.set_pref("yolo", "cuda:0")
    parent = isolated.parent
    leftovers = [
        p for p in parent.iterdir()
        if p.name.startswith(".device_prefs.") and p.suffix == ".tmp"
    ]
    assert leftovers == [], f"atomic write leaked tmp files: {leftovers}"


def test_all_prefs_returns_snapshot_copy(isolated: Path) -> None:
    device_prefs.set_pref("sam", "cuda:0")
    snap = device_prefs.all_prefs()
    snap["sam"] = "mutated"
    # Internal state still authoritative.
    assert device_prefs.get_pref("sam") == "cuda:0"
