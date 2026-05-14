from carve_model.sam.lifecycle import SamVariant, SamCapabilityError


class MinimalVariant:
    """Smallest object that satisfies the SamVariant protocol."""
    name = "fake"
    device = None
    build_key = ("fake", "fp32", "sdpa")
    supports_text = False
    supports_box = False
    supports_visual = False

    def load(self, device): pass
    def unload(self): pass
    def set_image(self, image): return "h"
    def cached_image_hash(self): return "h"
    def cached_image_shape(self): return (1, 1)
    def extract_embedding(self): return None
    def set_prev_logits(self, low_res_logits, n_points): pass
    def get_prev_logits(self): return (None, 0)
    def predict_point(self, **kw): return (None, None, None)
    def predict_text(self, **kw): raise SamCapabilityError("nope")
    def predict_box(self, **kw): raise SamCapabilityError("nope")
    def predict_visual(self, **kw): raise SamCapabilityError("nope")


def test_minimal_object_satisfies_protocol():
    v: SamVariant = MinimalVariant()  # type: ignore[assignment]
    assert v.name == "fake"
    assert v.supports_text is False
