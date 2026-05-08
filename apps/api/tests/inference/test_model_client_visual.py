"""Tests for sam_visual_prompt in model_client."""
import httpx
import pytest

from carve_api.inference import model_client
from carve_api.inference.model_client import sam_visual_prompt, set_test_transport


@pytest.fixture(autouse=True)
def _restore_transport():
    yield
    set_test_transport(None)


def test_sam_visual_prompt_posts_to_model_service():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = request.content.decode()
        return httpx.Response(
            200,
            json=[{
                "counts": "0", "size": [10, 10], "score": 0.9,
                "bbox": [1, 1, 9, 9],
                "polygon": [[1, 1], [9, 1], [9, 9]],
            }],
        )

    set_test_transport(httpx.MockTransport(handler))
    out = sam_visual_prompt(
        refer_b64="aGVsbG8=",
        regions=[{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
        target_b64="aGVsbG8=",
    )
    assert "/sam/visual-prompt" in captured["url"]
    assert "refer_b64" in captured["body"]
    assert "regions" in captured["body"]
    assert "target_b64" in captured["body"]
    assert out[0]["score"] == 0.9
