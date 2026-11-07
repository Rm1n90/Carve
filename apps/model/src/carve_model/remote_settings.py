"""Settings a superadmin saved in Carve (Settings → Configuration) for the
model service.

At start, before PyTorch touches the GPU, the service asks the API for
the variables saved for it and puts them into its own environment, where
the rest of the code already reads them. A value not saved there keeps
what docker-compose gave the container. Any failure (the API not up yet,
a network blip) leaves the container's environment as it is: the
service must start whatever happens here.

The request is authenticated with a token both sides derive from the
object storage password, which only Carve's own containers hold.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
import urllib.request

log = logging.getLogger(__name__)

# Only these may be set this way; anything else in the answer is ignored.
ALLOWED = frozenset({
    "SAM_MODEL", "CUDA_VISIBLE_DEVICES", "SAM_DTYPE", "SAM_ATTN_IMPL", "SAM_COMPILE",
    "SAM_CLIENT_ENCODE", "SAM3_TOPK_PROPOSALS", "PYTORCH_CUDA_ALLOC_CONF",
    "VLM_FO1_AVAILABLE", "HF_TOKEN",
})

# The fingerprint of what was applied, reported by /health so the page can
# tell whether a restart is still needed. "" when nothing came from the API.
version = ""


def token() -> str:
    secret = os.environ.get("MINIO_ROOT_PASSWORD", "").encode()
    return hmac.new(secret, b"carve service settings v1", hashlib.sha256).hexdigest()


def apply(attempts: int = 5, wait_s: float = 2.0) -> None:
    """Fetch and apply the saved settings; never raises."""
    global version
    url = os.environ.get("CARVE_SETTINGS_URL", "").strip()
    if not url or not os.environ.get("MINIO_ROOT_PASSWORD"):
        return
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"X-Carve-Service-Token": token()})
            with urllib.request.urlopen(req, timeout=3) as r:  # noqa: S310 — internal URL
                body = json.loads(r.read())
            env = {k: str(v) for k, v in (body.get("env") or {}).items()
                   if k in ALLOWED and "\n" not in str(v)}
            os.environ.update(env)
            version = str(body.get("version") or "")
            log.info("settings from Carve applied: %s", ", ".join(sorted(env)) or "none")
            return
        except Exception as exc:  # noqa: BLE001 — must not stop the service
            if attempt == attempts:
                log.warning("settings from Carve not applied (%s); using the container's", exc)
                return
            time.sleep(wait_s)
