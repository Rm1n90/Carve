"""Feature pooling primitives for SAM visual prompt encoding.

See docs/superpowers/specs/2026-05-08-sam-visual-prompt-design.md Section 5.5–5.6.
All ops accept and return numpy arrays — torch wrapping happens at the
adapter boundary so this module is import-cheap and unit-testable.
"""
from __future__ import annotations

import numpy as np


def masked_mean(feats, mask):
    """Mean over masked spatial cells. ``feats`` is (H, W, D); ``mask`` (H, W) bool.

    Empty mask falls back to global mean so the caller never sees NaN.
    """
    if mask.sum() == 0:
        return feats.reshape(-1, feats.shape[-1]).mean(axis=0)
    return feats[mask].mean(axis=0)


def l2norm(v, eps=1e-12):
    """L2-normalise ``v`` along its last axis. Zero-safe."""
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, eps) if (n > 0).any() else v


def fuse_dense_global(dense, glob, *, alpha=0.7):
    """Fuse dense + global L2-normed vectors. Returns L2-normed (D,)."""
    return l2norm(alpha * dense + (1.0 - alpha) * glob)


def self_attn_pool(feats, mask, global_vec, *, tau=0.07):
    """Attention-weighted pool: weights = softmax(cos_sim(cell, global) / tau).

    Only masked cells contribute. Returns a single L2-normed (D,) vector.
    """
    H, W, D = feats.shape
    flat = feats.reshape(-1, D)
    mflat = mask.reshape(-1)
    if mflat.sum() == 0:
        mflat = np.ones_like(mflat)
    cells = flat[mflat]
    cells_n = cells / np.maximum(np.linalg.norm(cells, axis=-1, keepdims=True), 1e-12)
    sims = cells_n @ global_vec
    sims = sims / max(tau, 1e-6)
    sims = sims - sims.max()
    w = np.exp(sims)
    w = w / w.sum()
    pooled = (w[:, None] * cells).sum(axis=0)
    return l2norm(pooled)


def cross_image_refine(exemplar, target_feats, *, k=10, beta=0.2):
    """Blend ``exemplar`` with the mean of the top-k most-similar target cells."""
    H, W, D = target_feats.shape
    flat = target_feats.reshape(-1, D)
    flat_n = flat / np.maximum(np.linalg.norm(flat, axis=-1, keepdims=True), 1e-12)
    sims = flat_n @ exemplar
    k = min(k, sims.shape[0])
    top_idx = np.argpartition(-sims, k - 1)[:k]
    top_mean = l2norm(flat[top_idx].mean(axis=0))
    return l2norm((1.0 - beta) * exemplar + beta * top_mean)
