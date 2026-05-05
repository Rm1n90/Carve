"""VLM-FO1 sidecar service.

This is the second of two model containers. It runs the upstream
``om-ai-lab/VLM-FO1`` package on its native ``transformers==4.50.1``,
isolated from the main ``model`` service which runs SAM 3 on
``transformers==5.0.0``. Communicates over HTTP — see ``main:app``.
"""
