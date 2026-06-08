"""Stage 4 provisioning — client-side SAM decode assets.

Downloads the per-variant browser DECODER bundles into the web container's
``public/models/`` and copies the onnxruntime-web WASM runtime so the browser
can decode clicks locally. The vision ENCODER stays server-side and is fetched
lazily by the model service (``carve_model.sam.onnx_encoder``) when
``SAM_CLIENT_ENCODE=1``; pass ``--prewarm-encoders`` to pull it ahead of time
(run that where the model service's HF cache lives).

What it places:
  - apps/web/public/models/sam3.1.decoder.onnx        (SAM 3 tracker decoder)
  - apps/web/public/models/sam2.1-large.decoder.onnx  (SAM 2.1 large decoder)
  - apps/web/public/models/ort/*.wasm + *.mjs         (onnxruntime-web runtime)

The HF decoder export stores weights in an external ``_data`` sidecar; the
browser's onnxruntime-web does not auto-fetch sidecars by URL, so we re-save
each decoder as a single self-contained ``.onnx`` (inline weights). We ship the
**fp32** decoder — the exact graph the Stage-0 golden parity validated
(IoU ~0.99) — so client masks match the server. ~22 MB each, cached after the
first load.

Run (host model venv; needs onnx + huggingface_hub + onnxruntime already in
apps/model/.venv):
    apps/model/.venv/bin/pip install -q onnx huggingface_hub
    apps/model/.venv/bin/python apps/model/scripts/provision_sam_decoders.py
    # then enable the server side and restart the model service:
    #   SAM_CLIENT_ENCODE=1  (see carve_model.sam.onnx_encoder)

Verify only (no downloads):
    apps/model/.venv/bin/python apps/model/scripts/provision_sam_decoders.py --check

VRAM budget: enabling client encode adds ONE resident ONNX vision encoder per
active variant alongside the native SAM model (fp16 encoder ~0.9 GB). Budget it
against the SAM admission floors (see carve_model.admission); the encoder is
loaded once and reused, and decode no longer touches the GPU at all.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

# apps/model/scripts/<this> -> repo root is 3 parents up.
REPO_ROOT = Path(__file__).resolve().parents[3]
WEB_MODELS = REPO_ROOT / "apps" / "web" / "public" / "models"
ORT_WASM_DST = WEB_MODELS / "ort"

# encoder_id -> (HF repo, decoder file). encoder_id is the SAM_MODEL value and
# the browser decoder filename stem (see canvas/sam/decoder.ts ENCODER_CONFIGS).
DECODERS: dict[str, tuple[str, str]] = {
    "sam3.1": (
        "onnx-community/sam3-tracker-ONNX",
        "onnx/prompt_encoder_mask_decoder.onnx",
    ),
    "sam2.1-large": (
        "onnx-community/sam2.1-hiera-large-ONNX",
        "onnx/prompt_encoder_mask_decoder.onnx",
    ),
}

ENCODERS: dict[str, tuple[str, str]] = {
    "sam3.1": ("onnx-community/sam3-tracker-ONNX", "onnx/vision_encoder_fp16.onnx"),
    "sam2.1-large": (
        "onnx-community/sam2.1-hiera-large-ONNX",
        "onnx/vision_encoder_fp16.onnx",
    ),
}


def _download_and_inline(repo: str, fname: str, out_path: Path) -> None:
    """Download a decoder (+ external data) and re-save it as one .onnx."""
    from huggingface_hub import hf_hub_download  # noqa: PLC0415
    import onnx  # noqa: PLC0415

    local = hf_hub_download(repo, fname)
    # The fp32 decoder externalises weights; pull the sidecar so onnx.load can
    # resolve it. Absent for variants that inline weights — that's fine.
    try:
        hf_hub_download(repo, fname + "_data")
    except Exception:  # noqa: BLE001
        pass
    model = onnx.load(local)  # resolves external data from the sibling _data
    out_path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save_model(model, str(out_path), save_as_external_data=False)


def provision_decoders(force: bool) -> None:
    for encoder_id, (repo, fname) in DECODERS.items():
        out = WEB_MODELS / f"{encoder_id}.decoder.onnx"
        if out.exists() and not force:
            print(f"[skip] {out.name} already present")
            continue
        print(f"[decoder] {encoder_id} <- {repo}/{fname}")
        _download_and_inline(repo, fname, out)
        print(f"[ok]   {out.name} ({out.stat().st_size // 1024} KiB)")


def copy_wasm(force: bool) -> None:
    """Copy onnxruntime-web's WASM + loaders to public/models/ort/.

    The worker sets ``ort.env.wasm.wasmPaths = '/models/ort/'`` so the runtime
    self-hosts (no third-party CDN). Source is resolved from the web app's
    installed onnxruntime-web (pnpm-aware).
    """
    web = REPO_ROOT / "apps" / "web"
    candidates = sorted(
        web.glob("node_modules/.pnpm/onnxruntime-web@*/node_modules/onnxruntime-web/dist")
    ) + sorted(web.glob("node_modules/onnxruntime-web/dist"))
    if not candidates:
        print("[warn] onnxruntime-web dist not found — run `pnpm install` in apps/web")
        return
    dist = candidates[-1]
    ORT_WASM_DST.mkdir(parents=True, exist_ok=True)
    copied = 0
    for pattern in ("*.wasm", "ort-wasm*.mjs"):
        for src in dist.glob(pattern):
            dst = ORT_WASM_DST / src.name
            if dst.exists() and not force:
                continue
            shutil.copy2(src, dst)
            copied += 1
    print(f"[wasm] {copied} file(s) -> {ORT_WASM_DST} (from {dist})")


def prewarm_encoders() -> None:
    from huggingface_hub import hf_hub_download  # noqa: PLC0415

    for encoder_id, (repo, fname) in ENCODERS.items():
        print(f"[encoder] pre-warm {encoder_id} <- {repo}/{fname}")
        hf_hub_download(repo, fname)
        try:
            hf_hub_download(repo, fname + "_data")
        except Exception:  # noqa: BLE001
            pass


def check() -> bool:
    ok = True
    for encoder_id in DECODERS:
        p = WEB_MODELS / f"{encoder_id}.decoder.onnx"
        present = p.exists()
        ok = ok and present
        size = f"{p.stat().st_size // 1024} KiB" if present else "—"
        print(f"  decoder {encoder_id:14s}: {'OK ' if present else 'MISSING'} {size}")
    wasm = list(ORT_WASM_DST.glob("*.wasm")) if ORT_WASM_DST.exists() else []
    ok = ok and len(wasm) > 0
    print(f"  ort wasm           : {len(wasm)} file(s) in {ORT_WASM_DST}")
    print("CHECK:", "PASS" if ok else "INCOMPLETE")
    return ok


def main() -> None:
    ap = argparse.ArgumentParser(description="Provision client-side SAM decode assets")
    ap.add_argument("--check", action="store_true", help="verify presence only; no downloads")
    ap.add_argument("--force", action="store_true", help="re-download/overwrite existing files")
    ap.add_argument(
        "--prewarm-encoders",
        action="store_true",
        help="also pull the server-side vision encoders into the local HF cache",
    )
    args = ap.parse_args()

    if args.check:
        sys.exit(0 if check() else 1)

    provision_decoders(args.force)
    copy_wasm(args.force)
    if args.prewarm_encoders:
        prewarm_encoders()
    print()
    check()
    print(
        "\nNext: set SAM_CLIENT_ENCODE=1 on the model service and restart it, "
        "then run the Stage-5 live two-user check."
    )


if __name__ == "__main__":
    main()
