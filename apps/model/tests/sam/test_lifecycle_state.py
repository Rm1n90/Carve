from carve_model.sam.lifecycle import LoadState


def test_load_state_defaults_to_idle():
    s = LoadState.idle()
    assert s.kind == "idle"
    assert s.variant is None
    assert s.loaded_at is None
    assert s.started_at is None
    assert s.error is None


def test_load_state_loading_constructor():
    s = LoadState.loading("sam3.1", started_at="2026-05-14T10:00:00Z")
    assert s.kind == "loading"
    assert s.variant == "sam3.1"
    assert s.started_at == "2026-05-14T10:00:00Z"


def test_load_state_ready_constructor():
    s = LoadState.ready("sam2.1-large", loaded_at="2026-05-14T10:00:05Z")
    assert s.kind == "ready"
    assert s.variant == "sam2.1-large"
    assert s.loaded_at == "2026-05-14T10:00:05Z"


def test_load_state_error_constructor():
    s = LoadState.error_("sam3.1", "CUDA out of memory")
    assert s.kind == "error"
    assert s.variant == "sam3.1"
    assert s.error == "CUDA out of memory"


def test_load_state_is_immutable():
    import dataclasses
    s = LoadState.idle()
    assert dataclasses.is_dataclass(s)
    try:
        s.kind = "ready"  # type: ignore[misc]
    except dataclasses.FrozenInstanceError:
        return
    raise AssertionError("LoadState should be frozen")
