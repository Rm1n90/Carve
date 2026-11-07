__version__ = "0.1.0"

# Settings a superadmin saved in Carve go into the environment first,
# before any module reads it or PyTorch touches the GPU. A no-op unless
# CARVE_SETTINGS_URL is set (docker-compose sets it; tests do not).
from carve_model import remote_settings as _remote_settings  # noqa: E402

_remote_settings.apply()
