"""Tests for SAM_MODEL=sam3 deprecation warning (Task 6.1).

Phase 6 of the SAM Lifecycle Manager refactor deprecates the standalone
``sam3`` (transformers) variant. ``SAM_MODEL=sam3`` should auto-remap to
``sam3.1`` and emit a one-time WARN log so existing operator configs keep
working until they update their env.
"""

import logging


def test_sam3_env_remaps_to_sam3p1(monkeypatch, caplog):
    from carve_model.sam.predictor import get_sam_model
    import carve_model.sam.predictor as p

    monkeypatch.setenv("SAM_MODEL", "sam3")
    p._SAM3_WARNED = False
    caplog.set_level(logging.WARNING, logger="carve_model.sam.predictor")

    name = get_sam_model()
    assert name == "sam3.1"
    assert any(
        "sam3" in rec.message and "deprecated" in rec.message.lower()
        for rec in caplog.records
    )


def test_sam3_warning_fires_only_once(monkeypatch, caplog):
    from carve_model.sam.predictor import get_sam_model
    import carve_model.sam.predictor as p

    monkeypatch.setenv("SAM_MODEL", "sam3")
    p._SAM3_WARNED = False
    caplog.set_level(logging.WARNING, logger="carve_model.sam.predictor")
    get_sam_model()
    get_sam_model()
    get_sam_model()
    deprecation_logs = [
        r for r in caplog.records if "deprecated" in r.message.lower()
    ]
    assert len(deprecation_logs) == 1
