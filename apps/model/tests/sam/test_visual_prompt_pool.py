import numpy as np

from carve_model.sam.visual_prompt_pool import (
    masked_mean, l2norm, fuse_dense_global, self_attn_pool, cross_image_refine,
)


def test_masked_mean_returns_only_masked_cells():
    feats = np.zeros((4, 4, 3), dtype=np.float32)
    feats[0, 0] = [1.0, 2.0, 3.0]
    feats[3, 3] = [4.0, 5.0, 6.0]
    mask = np.zeros((4, 4), dtype=bool)
    mask[0, 0] = True
    mask[3, 3] = True
    np.testing.assert_allclose(masked_mean(feats, mask), [2.5, 3.5, 4.5])


def test_masked_mean_empty_mask_returns_global_mean():
    feats = np.ones((2, 2, 3), dtype=np.float32) * 5.0
    np.testing.assert_allclose(masked_mean(feats, np.zeros((2, 2), dtype=bool)), [5.0, 5.0, 5.0])


def test_l2norm_unit_norm():
    np.testing.assert_allclose(np.linalg.norm(l2norm(np.array([3.0, 0.0, 4.0]))), 1.0, atol=1e-6)


def test_l2norm_zero_vector_safe():
    out = l2norm(np.zeros(5))
    assert np.all(np.isfinite(out))
    assert np.linalg.norm(out) == 0.0


def test_fuse_dense_global_default_alpha_0_7():
    dense = l2norm(np.array([1.0, 0.0, 0.0]))
    glob = l2norm(np.array([0.0, 1.0, 0.0]))
    np.testing.assert_allclose(
        fuse_dense_global(dense, glob),
        l2norm(0.7 * dense + 0.3 * glob),
    )


def test_fuse_dense_global_alpha_override():
    dense = l2norm(np.array([1.0, 0.0]))
    glob = l2norm(np.array([0.0, 1.0]))
    np.testing.assert_allclose(
        fuse_dense_global(dense, glob, alpha=0.5),
        l2norm(0.5 * dense + 0.5 * glob),
    )


def test_self_attn_pool_emphasises_high_sim_cells():
    feats = np.zeros((1, 3, 4), dtype=np.float32)
    feats[0, 0] = [1.0, 0.0, 0.0, 0.0]
    feats[0, 1] = [0.0, 1.0, 0.0, 0.0]
    feats[0, 2] = [0.0, 0.0, 1.0, 0.0]
    mask = np.ones((1, 3), dtype=bool)
    global_vec = l2norm(np.array([0.0, 1.0, 0.0, 0.0]))
    out = self_attn_pool(feats, mask, global_vec, tau=0.01)
    np.testing.assert_allclose(out, l2norm(feats[0, 1]), atol=1e-3)


def test_cross_image_refine_blends_top_k():
    exemplar = l2norm(np.array([1.0, 0.0]))
    target_feats = np.zeros((2, 2, 2), dtype=np.float32)
    target_feats[0, 0] = [1.0, 0.0]
    target_feats[0, 1] = [0.9, 0.1]
    target_feats[1, 0] = [-1.0, 0.0]
    target_feats[1, 1] = [0.0, 1.0]
    out = cross_image_refine(exemplar, target_feats, k=2, beta=0.5)
    top_mean = l2norm(np.array([0.95, 0.05]))
    expected = l2norm(0.5 * exemplar + 0.5 * top_mean)
    np.testing.assert_allclose(out, expected, atol=1e-5)
