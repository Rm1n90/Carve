# Armin Mehri — mehri.armin@gmail.com
"""Which settings can be changed in the app, and how each is checked.

API and worker settings apply within seconds; the model service reads
its own when it starts (the page restarts it); the backup service before
each run. What Carve needs to reach its own database, storage and
certificates stays in ``.env`` and is listed in ``STARTUP``: those values
must match the services as they are, so changing one here would only
cut the app off from its data.
"""
from __future__ import annotations

from dataclasses import dataclass

SECRET = "secret"  # noqa: S105 — a kind of setting, not a password
TEXT = "text"
URL = "url"
INT = "int"
FLOAT = "float"
BOOL = "bool"
CHOICE = "choice"


@dataclass(frozen=True)
class SettingDef:
    # The environment variable the value stands in for.
    key: str
    # The ``Settings`` attribute it sets (API and worker settings only).
    field: str | None
    group: str
    label: str
    help: str
    kind: str
    minimum: float | None = None
    maximum: float | None = None
    # Shown next to numbers ("bytes" is also shown in GiB).
    unit: str | None = None
    # Allowed comma-separated items, for a list setting.
    choices: tuple[str, ...] = ()
    # Whether saving an empty value is allowed (it then overrides the
    # environment with "nothing", e.g. turns SSO off).
    allow_empty: bool = False
    # Logo AI provider whose key a test call can check.
    test_provider: str | None = None
    # Which part of Carve reads it: "api" (API and worker, within
    # seconds), "model" (the model service, when it restarts) or
    # "backup" (the backup service, before its next run).
    service: str = "api"
    # The variable the service reads, when it differs from ``key``.
    env_name: str | None = None
    # Allowed values for a single-choice setting.
    options: tuple[str, ...] = ()
    # What the page shows for each of ``options`` (same order); the value
    # itself when empty.
    option_labels: tuple[str, ...] = ()
    # Pages where the value is made or managed: (button text, address).
    links: tuple[tuple[str, str], ...] = ()

    @property
    def target_env(self) -> str:
        return self.env_name or self.key


_PROVIDERS = "Logo AI providers"
_LOGO_AI = "Logo AI"
_SIGN_IN = "Sign-in"
_SSO = "Single sign-on"
_LIMITS = "Uploads and models"
_NETWORK = "Addresses"
_MODEL = "Model service (SAM, YOLO)"
_BACKUP = "Database backups"
_ACCESS = "Member access"
_WEB_COLLECT = "Collect from web"

API = "api"
MODEL = "model"
BACKUP = "backup"

# Who below admin may use an AI tool (admins always may). "opened_tasks"
# follows each task's "AI tools for members" switch, which admins set
# from the task's menu.
ADMINS_ONLY = "admins"
OPENED_TASKS = "opened_tasks"
ALL_TASKS = "all_tasks"
MEMBER_MODES = (ADMINS_ONLY, OPENED_TASKS, ALL_TASKS)
_MEMBER_MODE_LABELS = (
    "Admins only",
    "Members, on tasks opened for them",
    "Members, on every task they can open",
)


def _member_access(key: str, field: str, label: str, help_: str) -> SettingDef:
    return SettingDef(
        key, field, _ACCESS, label,
        help_ + " Admins always can. \"Opened for them\" follows each task's AI tools for "
        "members switch (the task's ⋮ menu).",
        CHOICE, options=MEMBER_MODES, option_labels=_MEMBER_MODE_LABELS,
    )


_OIDC_CONSOLES = {
    "google": ("Google Cloud credentials", "https://console.cloud.google.com/apis/credentials"),
    "microsoft": (
        "Microsoft app registrations",
        "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    ),
}


def _oidc(provider: str, name: str) -> tuple[SettingDef, ...]:
    p = provider.upper()
    return (
        SettingDef(
            f"OIDC_{p}_CLIENT_ID", f"oidc_{provider}_client_id", _SSO,
            f"{name} client ID", f"The OAuth client ID of the app registered with {name}.", TEXT,
            links=(_OIDC_CONSOLES[provider],),
        ),
        SettingDef(
            f"OIDC_{p}_CLIENT_SECRET", f"oidc_{provider}_client_secret", _SSO,
            f"{name} client secret", "Stored encrypted; never shown again after saving.", SECRET,
        ),
        SettingDef(
            f"OIDC_{p}_DISCOVERY_URL", f"oidc_{provider}_discovery_url", _SSO,
            f"{name} discovery URL", "The provider's .well-known/openid-configuration URL.", URL,
        ),
        SettingDef(
            f"OIDC_{p}_REDIRECT_URI", f"oidc_{provider}_redirect_uri", _SSO,
            f"{name} redirect URI",
            "This app's callback URL, exactly as registered with the provider.", URL,
        ),
    )


SETTINGS: tuple[SettingDef, ...] = (
    SettingDef(
        "OPENAI_API_KEY", "openai_api_key", _PROVIDERS, "OpenAI API key",
        "The key Logo AI uses to run the GPT models; OpenAI charges each request to it. In "
        "your OpenAI account: API keys, Create new secret key (the account needs credit "
        "under Billing).",
        SECRET, test_provider="openai",
        links=(
            ("Get an OpenAI key", "https://platform.openai.com/api-keys"),
            ("OpenAI billing", "https://platform.openai.com/settings/organization/billing/overview"),
        ),
    ),
    SettingDef(
        "GEMINI_API_KEY", "gemini_api_key", _PROVIDERS, "Google Gemini API key",
        "The key Logo AI uses to run the Gemini models. In Google AI Studio: Get API key, "
        "Create API key. Its Google Cloud project needs billing turned on (Gemini 4 Argon "
        "has no free tier).",
        SECRET, test_provider="gemini",
        links=(("Get a Gemini key", "https://aistudio.google.com/app/apikey"),),
    ),
    SettingDef(
        "ANTHROPIC_API_KEY", "anthropic_api_key", _PROVIDERS, "Anthropic API key",
        "The key Logo AI uses to run the Claude models. In the Claude Console: API keys, "
        "Create key (the organization needs credit under Billing).",
        SECRET, test_provider="anthropic",
        links=(("Get an Anthropic key", "https://platform.claude.com/settings/keys"),),
    ),
    SettingDef(
        "OPENAI_ADMIN_KEY", "openai_admin_key", _PROVIDERS, "OpenAI admin key",
        "Optional, and not a second way to run models: it can only read what your OpenAI "
        "organization spent, which the Logo AI Billing tab shows. Only an organization "
        "owner can make one: Settings, Organization, Admin keys.",
        SECRET,
        links=(
            ("Get an OpenAI admin key", "https://platform.openai.com/settings/organization/admin-keys"),
        ),
    ),
    _member_access(
        "MEMBERS_SAM", "members_sam", "SAM",
        "Click, box and text segmentation, SAM 3 automatic finding, video tracking and "
        "turning boxes into shapes.",
    ),
    _member_access(
        "MEMBERS_MY_MODEL", "members_my_model", "My model (YOLO)",
        "Predicting with your trained YOLO weights, on one image or a whole task.",
    ),
    _member_access(
        "MEMBERS_YOLOE", "members_yoloe", "Smart Find (YOLOE)",
        "Finding objects by text, by an example, or with no prompt.",
    ),
    _member_access(
        "MEMBERS_LOGO_AI", "members_logo_ai", "Logo AI",
        "Logo detection with the hosted models. It costs money on every image.",
    ),
    SettingDef(
        "LOGO_AI_CONCURRENCY", "logo_ai_concurrency", _LOGO_AI, "Requests at once (realtime)",
        "Requests in flight at once during a realtime or Flex run. Raise it only if the "
        "provider account's rate limits allow.",
        INT, minimum=1, maximum=32,
    ),
    SettingDef(
        "LOGO_AI_BATCH_PART_REQUESTS", "logo_ai_batch_part_requests", _LOGO_AI,
        "Requests per batch part",
        "Requests handed to the provider in one batch. Lower it if one part is larger than "
        "the account's batch queue allows.",
        INT, minimum=1, maximum=50_000,
    ),
    SettingDef(
        "WEB_COLLECT_THREADS", "web_collect_threads", _WEB_COLLECT, "Downloads at once",
        "Images a run downloads in parallel (never more than 4 from the same site).",
        INT, minimum=1, maximum=64,
    ),
    SettingDef(
        "WEB_COLLECT_BLOCKED_SITES", "web_collect_blocked_sites", _WEB_COLLECT,
        "More blocked sites",
        "Sites never collected from, besides the built-in lists (stock agencies such as "
        "Alamy, Adobe Stock, Getty and Shutterstock; AI-image galleries; Chinese sites). "
        "Domains separated by commas, e.g. example.com, photos.example.org.",
        TEXT, allow_empty=True,
    ),
    SettingDef(
        "WEB_COLLECT_AI_THRESHOLD", "web_collect_ai_threshold", _WEB_COLLECT,
        "AI-image rejection score",
        "Images the AI-image detector scores at or above this (0–1) are thrown away. "
        "Lower rejects more.",
        FLOAT, minimum=0.05, maximum=1.0,
    ),
    SettingDef(
        "WEB_COLLECT_WATERMARK_THRESHOLD", "web_collect_watermark_threshold", _WEB_COLLECT,
        "Watermark rejection score",
        "Images the watermark detector scores at or above this (0–1) are thrown away. "
        "Lower rejects more.",
        FLOAT, minimum=0.05, maximum=1.0,
    ),
    SettingDef(
        "WEB_COLLECT_RELEVANCE_THRESHOLD", "web_collect_relevance_threshold", _WEB_COLLECT,
        "Keyword match score",
        "Images that match their keyword less than this are thrown away as off topic. "
        "0.07 keeps about 99 % of the right images; higher rejects more, lower keeps more.",
        FLOAT, minimum=0.0, maximum=0.3,
    ),
    SettingDef(
        "WEB_COLLECT_CONTACT", "web_collect_contact", _WEB_COLLECT, "Contact for image sites",
        "An email or web address sent to Wikimedia Commons and Openverse with every "
        "request, as Wikimedia's rules ask, so they can reach you instead of blocking.",
        TEXT, allow_empty=True,
    ),
    SettingDef(
        "WEB_COLLECT_PEXELS_KEY", "web_collect_pexels_key", _WEB_COLLECT, "Pexels API key",
        "Free; turns on Pexels as a source (free-licence photos, 200 searches an hour).",
        SECRET, allow_empty=True, links=(("Get a Pexels key", "https://www.pexels.com/api/"),),
    ),
    SettingDef(
        "WEB_COLLECT_PIXABAY_KEY", "web_collect_pixabay_key", _WEB_COLLECT, "Pixabay API key",
        "Free; turns on Pixabay as a source (free-licence photos and illustrations).",
        SECRET, allow_empty=True, links=(("Get a Pixabay key", "https://pixabay.com/api/docs/"),),
    ),
    SettingDef(
        "WEB_COLLECT_UNSPLASH_KEY", "web_collect_unsplash_key", _WEB_COLLECT,
        "Unsplash access key",
        "Free; turns on Unsplash as a source (free-licence photos; 50 searches an hour "
        "until Unsplash approves the app for more).",
        SECRET, allow_empty=True,
        links=(("Get an Unsplash key", "https://unsplash.com/oauth/applications"),),
    ),
    SettingDef(
        "JWT_ACCESS_TTL_MIN", "jwt_access_ttl_min", _SIGN_IN, "Access token lifetime",
        "How long a sign-in token lasts before the browser renews it. Applies to tokens "
        "issued from now on.",
        INT, minimum=1, maximum=1440, unit="minutes",
    ),
    SettingDef(
        "JWT_REFRESH_TTL_DAYS", "jwt_refresh_ttl_days", _SIGN_IN, "Stay signed in for",
        "How long someone stays signed in without entering their password again. Applies "
        "to sign-ins from now on.",
        INT, minimum=1, maximum=365, unit="days",
    ),
    SettingDef(
        "SSO_PROVIDERS", "sso_providers", _SSO, "Enabled SSO providers",
        "Comma-separated: google, microsoft. Empty turns single sign-on off.",
        TEXT, choices=("google", "microsoft"), allow_empty=True,
    ),
    *_oidc("google", "Google"),
    *_oidc("microsoft", "Microsoft"),
    SettingDef(
        "ASSET_MAX_BYTES", "asset_max_bytes", _LIMITS, "Largest upload",
        "The largest single file that can be uploaded.",
        INT, minimum=1024 * 1024, maximum=1024**4, unit="bytes",
    ),
    SettingDef(
        "MODEL_TIMEOUT_SECONDS", "model_timeout_seconds", _LIMITS, "Model service timeout",
        "How long the API waits for SAM and YOLO answers before giving up.",
        FLOAT, minimum=5, maximum=3600, unit="seconds",
    ),
    SettingDef(
        "MINIO_PUBLIC_ENDPOINT", "minio_public_endpoint", _NETWORK,
        "Storage address for browsers",
        "The address browsers load images and videos from, e.g. http://192.168.1.142:9000. "
        "Empty: the internal storage address. If images stop loading after a change, "
        "clear it.",
        URL, allow_empty=True,
    ),
    SettingDef(
        "MODEL_BASE_URL", "model_base_url", _NETWORK, "Model service address",
        "Where the API reaches SAM and YOLO. Normally http://model:8100.",
        URL,
    ),
    SettingDef(
        "CORS_ORIGINS", "cors_origins", _NETWORK, "Allowed browser origins",
        "Other web addresses whose pages may call this API from a browser, comma-separated "
        "(e.g. https://tools.example.com). Carve's own pages never need this.",
        TEXT, allow_empty=True,
    ),
    # --- the model service: read when it starts ------------------------------
    SettingDef(
        "SAM_MODEL", "sam_model", _MODEL, "SAM variant at start",
        "The SAM model loaded when the model service starts. The Models page switches it "
        "for the running service.",
        CHOICE, service=MODEL,
        options=("sam2.1-tiny", "sam2.1-small", "sam2.1-base-plus", "sam2.1-large", "sam3.1"),
    ),
    SettingDef(
        "SAM_GPU_ID", None, _MODEL, "GPU for the model service",
        "The GPU number(s) the model service uses, e.g. 0, or 0,1.",
        TEXT, service=MODEL, env_name="CUDA_VISIBLE_DEVICES",
    ),
    SettingDef(
        "SAM_DTYPE", None, _MODEL, "SAM precision",
        "bf16 is the fastest on current GPUs; fp32 uses twice the memory.",
        CHOICE, service=MODEL, options=("bf16", "fp16", "fp32", "auto"),
    ),
    SettingDef(
        "SAM_ATTN_IMPL", None, _MODEL, "SAM attention",
        "sdpa unless there is a reason to change it.",
        CHOICE, service=MODEL, options=("sdpa", "eager", "flash_attention_2"),
    ),
    SettingDef(
        "SAM_COMPILE", None, _MODEL, "Compile SAM",
        "Faster masks after a slower first request.",
        BOOL, service=MODEL,
    ),
    SettingDef(
        "SAM_CLIENT_ENCODE", None, _MODEL, "Encode images in the browser",
        "Experimental: the browser computes the SAM image embedding (WebGPU).",
        BOOL, service=MODEL,
    ),
    SettingDef(
        "SAM3_TOPK_PROPOSALS", None, _MODEL, "SAM 3 proposals per prompt",
        "How many candidate objects SAM 3 keeps for a text or example prompt.",
        INT, service=MODEL, minimum=1, maximum=1000,
    ),
    SettingDef(
        "PYTORCH_CUDA_ALLOC_CONF", None, _MODEL, "PyTorch memory allocator",
        "Advanced. Default expandable_segments:True.",
        TEXT, service=MODEL,
    ),
    SettingDef(
        "VLM_FO1_AVAILABLE", None, _MODEL, "FO1 detection filter",
        "Use the FO1 vision-language filter on detections (needs the FO1 service).",
        BOOL, service=MODEL,
    ),
    SettingDef(
        "HF_TOKEN", None, _MODEL, "Hugging Face token",
        "Downloads gated models such as SAM 3. On huggingface.co: Settings, Access tokens, "
        "a Read token; the account must have accepted the model's terms on its page.",
        SECRET, service=MODEL,
        links=(("Get a Hugging Face token", "https://huggingface.co/settings/tokens"),),
    ),
    # --- the backup service: read before each run -----------------------------
    SettingDef(
        "BACKUP_HOUR", None, _BACKUP, "Daily backup hour (UTC)",
        "The hour the daily database dump is taken.",
        INT, service=BACKUP, minimum=0, maximum=23,
    ),
    SettingDef(
        "KEEP_DAILY", None, _BACKUP, "Daily dumps kept",
        "How many daily dumps are kept before the oldest is deleted.",
        INT, service=BACKUP, minimum=1, maximum=365,
    ),
    SettingDef(
        "KEEP_WEEKLY", None, _BACKUP, "Weekly dumps kept",
        "Sunday dumps kept.", INT, service=BACKUP, minimum=0, maximum=520,
    ),
    SettingDef(
        "KEEP_MONTHLY", None, _BACKUP, "Monthly dumps kept",
        "First-of-the-month dumps kept.", INT, service=BACKUP, minimum=0, maximum=240,
    ),
)

BY_KEY: dict[str, SettingDef] = {d.key: d for d in SETTINGS}

# What Carve needs to start, and cannot change from inside itself: the
# value has to match the database, storage and certificates as they are
# (a new database password here would not change the database's own; it
# would only cut the app off). Changed in .env, then the containers are
# recreated. (name, what it is, secret?)
STARTUP: tuple[tuple[str, str, bool], ...] = (
    ("POSTGRES_HOST", "Database host", False),
    ("POSTGRES_PORT", "Database port", False),
    ("POSTGRES_DB", "Database name", False),
    ("POSTGRES_USER", "Database user", False),
    ("POSTGRES_PASSWORD", "Database password", True),
    ("REDIS_HOST", "Redis host (job queue)", False),
    ("REDIS_PORT", "Redis port", False),
    ("MINIO_ENDPOINT", "Object storage address (internal)", False),
    ("MINIO_BUCKET", "Object storage bucket", False),
    ("MINIO_ROOT_USER", "Object storage user", False),
    ("MINIO_ROOT_PASSWORD", "Object storage password", True),
    ("JWT_SECRET", "Signs sign-in tokens (changing it signs everyone out)", True),
    ("PASSWORD_PEPPER", "Hashes passwords; also encrypts the secrets saved here", True),
    ("CARVE_DOMAIN", "The site's domain name (HTTPS certificate)", False),
    ("LETSENCRYPT_EMAIL", "Contact for the HTTPS certificate", False),
    ("NVIDIA_VISIBLE_DEVICES", "GPUs handed to the containers", False),
    ("API_ENV", "Environment name", False),
)
