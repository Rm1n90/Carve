# Plan 08 — Deployment Polish (TLS, Security, First-Run, Docs)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Tighten the production posture — Caddy TLS, rate limits, CSP, first-run wizard, backup script, in-browser WebGPU SAM decoder, SAM 3 admin toggle, and a docs site. Final v1 plan.

**Architecture:**
- Caddy auto-https with `LETSENCRYPT_EMAIL` and `VAA_DOMAIN` env vars; falls back to local cert when domain is `localhost`.
- Rate limit middleware (`slowapi`) on auth + heavy upload endpoints.
- Security headers (HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, CSP) emitted by Caddy.
- First-run wizard: when no users exist, the SPA shows an admin bootstrap page; afterward, public registration is disabled.
- `python-jose` → `PyJWT` migration (per Plan 01 final review note).
- WebGPU in-browser SAM decoder using ONNX Runtime Web; encoder still server-side.
- SAM 3 admin toggle for text-prompt mode (PCS).
- VitePress docs site at `apps/docs/`, mounted under `/docs`.

---

## Series context
- ✅ Plans 01–07 shipped
- **Plan 08 — Deployment polish** ← *this plan, final v1*

---

## Task 1: Caddy real TLS + secure headers

**Files:** modify `infra/caddy/Caddyfile`; modify `.env.example`.

**Step 1.1 — Replace `Caddyfile`:**

```caddyfile
{
  email {$LETSENCRYPT_EMAIL:admin@localhost}
}

{$VAA_DOMAIN:localhost} {
  encode zstd gzip

  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
    Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'"
    -Server
  }

  @api path /api/*
  handle @api {
    uri strip_prefix /api
    reverse_proxy api:8000
  }

  @model path /model/*
  handle @model {
    uri strip_prefix /model
    reverse_proxy model:8100
  }

  @docs path /docs/*
  handle @docs {
    uri strip_prefix /docs
    reverse_proxy docs:80
  }

  handle {
    reverse_proxy web:80
  }

  log {
    output stdout
    format console
  }
}
```

**Step 1.2 — `.env.example`** add at the bottom:
```
VAA_DOMAIN=localhost
LETSENCRYPT_EMAIL=
SAM_VARIANT=sam2
```

**Step 1.3 — Smoke** start with `VAA_DOMAIN=test.local` (after editing `/etc/hosts` to point `test.local` at the host). `curl -k https://test.local/api/health` returns `{"status":"ok"}`.

**Step 1.4 — Commit:** `infra: Caddy TLS + HSTS/CSP/Permissions-Policy headers`

---

## Task 2: Migrate `python-jose` → `PyJWT`

**Files:** modify `apps/api/pyproject.toml`; rewrite `apps/api/src/vaa_api/auth/jwt.py`.

**Step 2.1 — Replace dep:** remove `python-jose[cryptography]==3.3.0`; add `PyJWT==2.9.0`.

**Step 2.2 — `auth/jwt.py`:**

```python
from datetime import UTC, datetime, timedelta
from typing import Literal

import jwt as pyjwt

from vaa_api.config import get_settings

ALGORITHM = "HS256"
TokenType = Literal["access", "refresh"]


class InvalidToken(Exception):
    pass


def _now() -> datetime:
    return datetime.now(UTC)


def _encode(claims: dict) -> str:
    return pyjwt.encode(claims, get_settings().jwt_secret, algorithm=ALGORITHM)


def create_access_token(*, subject: str, role: str) -> str:
    s = get_settings(); now = _now()
    return _encode({
        "sub": subject, "role": role, "typ": "access",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=s.jwt_access_ttl_min)).timestamp()),
    })


def create_refresh_token(*, subject: str, role: str) -> str:
    s = get_settings(); now = _now()
    return _encode({
        "sub": subject, "role": role, "typ": "refresh",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=s.jwt_refresh_ttl_days)).timestamp()),
    })


def decode_token(token: str, *, expected_type: TokenType) -> dict:
    try:
        claims = pyjwt.decode(token, get_settings().jwt_secret, algorithms=[ALGORITHM])
    except pyjwt.PyJWTError as exc:
        raise InvalidToken(str(exc)) from exc
    if claims.get("typ") != expected_type:
        raise InvalidToken(f"expected {expected_type}, got {claims.get('typ')}")
    return claims
```

**Step 2.3 — All Plan 01 jwt tests pass unchanged** (the public API is identical: `create_access_token`, `create_refresh_token`, `decode_token`, `InvalidToken`).

**Step 2.4 — Commit:** `chore(api): migrate JWT library python-jose → PyJWT (CVE-clean, maintained)`

---

## Task 3: Rate limiting (slowapi)

**Files:** add `slowapi==0.1.9` to `apps/api/pyproject.toml`; new `apps/api/src/vaa_api/ratelimit.py`; modify `main.py` and decorate endpoints.

**Step 3.1 — `ratelimit.py`:**

```python
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address, storage_uri="memory://")
```

**Step 3.2 — `main.py`** wire it:

```python
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from vaa_api.ratelimit import limiter

app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)


@app.exception_handler(RateLimitExceeded)
async def _rate_limited(_, exc):
    return JSONResponse(status_code=429, content={"error": "rate_limited"})
```

**Step 3.3 — Decorate sensitive endpoints:**

```python
# auth router:
@router.post("/login")
@limiter.limit("10/minute")
def login(request: Request, payload: LoginIn, db: Session = Depends(get_db)) -> TokenPair:
    ...

@router.post("/register")
@limiter.limit("5/minute")
def register(request: Request, payload: RegisterIn, db: Session = Depends(get_db)) -> UserOut:
    ...
```

(slowapi requires the FastAPI handler to accept a `Request` parameter for the limiter to extract the IP.)

Apply also: `30/minute` on `/projects/{pid}/weights` (uploads), `100/minute` on `/tasks/{tid}/assets` (multipart).

**Step 3.4 — Tests:** call `/auth/login` with bad credentials 11 times in a row from the test client; assert the 11th response is 429.

**Step 3.5 — Commit:** `feat(api): rate limit on auth, weight upload, asset upload`

---

## Task 4: First-run wizard + admin user creation

**Files:** modify `apps/api/src/vaa_api/auth/router.py` and `service.py`; web `apps/web/src/pages/FirstRunWizard.tsx`; modify `routes/_root.tsx`.

**Step 4.1 — API:**

```python
@router.get("/bootstrap-status")
def bootstrap_status(db: Session = Depends(get_db)) -> dict:
    from sqlalchemy import select
    exists = db.execute(select(User).limit(1)).scalar_one_or_none() is not None
    return {"users_exist": exists}


# In `register` view:
@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def register(
    request: Request,
    payload: RegisterIn,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
) -> UserOut:
    bootstrapped = db.execute(select(User).limit(1)).scalar_one_or_none() is not None
    if bootstrapped:
        # Require admin auth from this point on
        from vaa_api.deps import _bearer_token
        from vaa_api.auth.jwt import decode_token, InvalidToken
        try:
            tok = _bearer_token(authorization)
            claims = decode_token(tok, expected_type="access")
            if claims.get("role") != "admin":
                raise HTTPException(status_code=403, detail="bootstrapped_admin_only")
        except InvalidToken as exc:
            raise HTTPException(status_code=401, detail="bootstrapped_admin_only") from exc
    try:
        user = AuthService(db).register(email=payload.email, password=payload.password)
    except EmailTaken as exc:
        raise _to_http(exc) from exc
    db.commit()
    return UserOut.from_orm_user(user)
```

(Alternatively, expose a separate `/admin/users` route — pick whichever feels clearest.)

**Step 4.2 — Web `FirstRunWizard`:** root layout fetches `/auth/bootstrap-status` once. If `users_exist=false`, render the wizard regardless of route. The form takes email + password + confirm; on submit calls `/auth/register`, then `/auth/login`, then redirects to `/projects`.

**Step 4.3 — Tests** (API):
- Initial state `users_exist=false`.
- `POST /auth/register` succeeds without auth.
- After one user exists, `users_exist=true`; `POST /auth/register` without auth returns 401.
- With admin token, `POST /auth/register` succeeds and creates a member.

**Step 4.4 — Commit:** `feat(api,web): first-run admin wizard; lock public registration after bootstrap`

---

## Task 5: WebGPU in-browser SAM decoder

**Files:** modify `apps/web/package.json` (`onnxruntime-web@1.20.1`); `apps/web/public/models/sam2_decoder.onnx` (~15 MB, downloaded from upstream); `apps/web/src/canvas/sam/{decoder,onnx}.ts`; modify `SamTool.ts`. API: extend `/assets/{id}/sam/encode` to also return the embedding bytes (base64) so the browser can decode locally.

**Step 5.1 — Encode endpoint update** in the model service: return `{image_hash, shape, embedding_b64}`. Cache `image_hash → embedding_bytes` in Redis with a 30-minute TTL.

**Step 5.2 — `decoder.ts`** runs the ONNX decoder via WebGPU; falls back to server `/sam/decode` if WebGPU is unavailable.

**Step 5.3 — `SamTool.ts`** detects WebGPU support (`navigator.gpu`), downloads the embedding once on activation, runs the decoder locally; otherwise calls the server `/sam/decode`.

**Step 5.4 — Commit:** `feat(web,api,model): in-browser SAM decoder via onnxruntime-web/WebGPU`

---

## Task 6: SAM 3 admin toggle + text-prompt UI

**Files:** modify `apps/model/Dockerfile` (optional sam3 install via build arg); `apps/model/src/vaa_model/sam/model.py`; new `text-prompt` endpoint; web `pages/DescribeAndSegmentModal.tsx`.

**Step 6.1 — Backend toggle:** env `SAM_VARIANT=sam2|sam3` (default `sam2`). When `sam3`, `_ensure()` loads `facebook/sam3` (gated HF repo; admin must accept license and provide HF token). Loading evicts the YOLO LRU.

**Step 6.2 — Endpoint:** `POST /sam/text-prompt` (SAM 3 only) accepts `{image_b64, text}`; returns `[{counts, size, score, bbox}]`. Reject with 409 `sam3_not_enabled` when `SAM_VARIANT=sam2`.

**Step 6.3 — Web modal "Describe and segment":** opens with a text input + class picker. Calls `/assets/{id}/sam/text-prompt`; shows all returned candidates with checkboxes. "Confirm" creates one polygon annotation per checked candidate.

**Step 6.4 — Commit:** `feat(model,web): SAM 3 admin toggle + Describe-and-segment text prompts`

---

## Task 7: Backup script

**Files:** new `scripts/backup.sh`; modify `README.md`.

**Step 7.1 — `scripts/backup.sh`:**

```bash
#!/usr/bin/env bash
set -euo pipefail
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="${1:-./backups}"
mkdir -p "$OUT"

source .env

echo "==> postgres dump"
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > "$OUT/pg-$TS.sql.gz"

echo "==> minio mirror"
docker run --rm --network vaa_default \
  -e MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000" \
  -v "$OUT:/out" \
  minio/mc:latest \
  mirror "local/${MINIO_BUCKET}" "/out/minio-$TS"

echo "==> done; backups at $OUT (timestamp $TS)"
```

`chmod +x scripts/backup.sh`.

**Step 7.2 — README** add a "Backups & restore" section documenting the script, recommended cron `0 3 * * * /path/to/scripts/backup.sh /var/backups/vaa`, and the restore procedure (`gunzip -c pg-*.sql.gz | docker compose exec -T postgres psql -U vaa vaa`; `mc mirror local/<bucket-restore>` for MinIO).

**Step 7.3 — Commit:** `infra: backup script for Postgres + MinIO with timestamped output`

---

## Task 8: Docs site (VitePress)

**Files:** `apps/docs/{package.json,vitepress.config.ts,index.md,getting-started.md,tools.md,exports.md,admin.md}`; modify `docker-compose.yml` (add `docs` service).

**Step 8.1 — Scaffold** `apps/docs` with `npm create vitepress@latest` (or write the config by hand). Site builds to `apps/docs/.vitepress/dist`.

**Step 8.2 — Pages:**
- `index.md` — landing page with feature overview.
- `getting-started.md` — first-run admin, upload images, define classes, annotate, export.
- `tools.md` — bbox / polygon / mask / SAM tool usage with screenshots; SAM 3 text prompts.
- `exports.md` — YOLO and COCO format documentation, class remap, presets.
- `admin.md` — managing users, SAM 3 toggle, backups.

**Step 8.3 — Dockerfile** (`apps/docs/Dockerfile`):

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build
FROM nginx:1.27-alpine
COPY --from=build /app/.vitepress/dist /usr/share/nginx/html
EXPOSE 80
```

**Step 8.4 — `docker-compose.yml`** add:

```yaml
  docs:
    build: ./apps/docs
    restart: unless-stopped
```

(Caddy already routes `/docs/*` from Task 1.)

**Step 8.5 — Commit:** `docs: VitePress site under /docs (getting-started, tools, exports, admin)`

---

## Task 9: Tag v1.0.0

```bash
git tag -a v1.0.0 -m "VisualAutoAnnotator v1.0.0 — full MVP feature set"
```

---

## Self-Review

| Spec § | Implemented |
|---|---|
| §17 TLS / HSTS / CSP / Permissions-Policy | Task 1 |
| §17 Rate limiting | Task 3 |
| §17 PyJWT migration | Task 2 |
| §16 First-run admin wizard | Task 4 |
| §17 Backups | Task 7 |
| §9.2 Browser SAM decoder | Task 5 |
| §9.3 SAM 3 text prompts | Task 6 |
| §15 Docs | Task 8 |

Out of scope (post v1):
- SSO via OIDC / SAML
- Real-time multi-user co-editing
- Pose / keypoints annotation
- OBB (oriented bounding boxes)
- Active learning loops
- Class taxonomy / parent-child
- Additional export formats (VOC, KITTI, MOT, Datumaro, Ultralytics NDJSON)

This concludes the v1 plan series.
