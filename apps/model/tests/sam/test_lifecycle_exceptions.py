from carve_model.sam.lifecycle import (
    SamCapabilityError,
    SamNotReadyError,
    SamLoadError,
)


def test_sam_not_ready_carries_state():
    e = SamNotReadyError("loading")
    assert e.state == "loading"
    assert "loading" in str(e)


def test_sam_capability_error_is_exception():
    assert issubclass(SamCapabilityError, Exception)


def test_sam_load_error_chains_cause():
    try:
        try:
            raise RuntimeError("inner")
        except RuntimeError as inner:
            raise SamLoadError("sam3.1", inner) from inner
    except SamLoadError as e:
        assert e.variant == "sam3.1"
        assert e.__cause__ is not None
