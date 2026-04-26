import pytest

from vaa_model.yolo.registry import WeightRegistry


def test_load_and_get(tmp_path) -> None:
    calls: list[str] = []

    def loader(p):
        calls.append(str(p))
        return f"model-{p.stem}"

    reg = WeightRegistry(capacity=2, loader=loader)
    weight = tmp_path / "w1.pt"
    weight.touch()

    m = reg.load("w1", weight)
    assert m == "model-w1"
    assert reg.get("w1") == "model-w1"
    # Second load is cached: loader not invoked again.
    reg.load("w1", weight)
    assert calls == [str(weight)]


def test_lru_eviction(tmp_path) -> None:
    def loader(p):
        return f"model-{p.stem}"

    reg = WeightRegistry(capacity=2, loader=loader)
    a = tmp_path / "a.pt"; a.touch()
    b = tmp_path / "b.pt"; b.touch()
    c = tmp_path / "c.pt"; c.touch()

    reg.load("a", a)
    reg.load("b", b)
    reg.load("c", c)  # evicts "a" (least recently used)
    assert reg.get("a") is None
    assert reg.get("b") == "model-b"
    assert reg.get("c") == "model-c"


def test_recently_accessed_is_kept(tmp_path) -> None:
    def loader(p):
        return f"m-{p.stem}"

    reg = WeightRegistry(capacity=2, loader=loader)
    a = tmp_path / "a.pt"; a.touch()
    b = tmp_path / "b.pt"; b.touch()
    c = tmp_path / "c.pt"; c.touch()

    reg.load("a", a)
    reg.load("b", b)
    # Touch "a" so it's most recent
    reg.load("a", a)
    reg.load("c", c)  # evicts "b" now
    assert reg.get("a") == "m-a"
    assert reg.get("b") is None
    assert reg.get("c") == "m-c"


def test_evict(tmp_path) -> None:
    def loader(p):
        return f"m-{p.stem}"
    reg = WeightRegistry(capacity=2, loader=loader)
    a = tmp_path / "a.pt"; a.touch()
    reg.load("a", a)
    assert reg.evict("a") is True
    assert reg.get("a") is None
    assert reg.evict("nope") is False


def test_load_without_loader_raises(tmp_path) -> None:
    reg = WeightRegistry(capacity=2)
    with pytest.raises(RuntimeError):
        reg.load("x", tmp_path / "x.pt")


def test_set_loader(tmp_path) -> None:
    reg = WeightRegistry(capacity=2)
    reg.set_loader(lambda p: f"m-{p.stem}")
    a = tmp_path / "a.pt"; a.touch()
    assert reg.load("a", a) == "m-a"
