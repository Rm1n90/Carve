import hmac
from hashlib import sha256

from passlib.hash import argon2

from carve_api.config import get_settings


def _peppered(password: str) -> str:
    pepper = get_settings().password_pepper.encode()
    return hmac.new(pepper, password.encode("utf-8"), sha256).hexdigest()


def hash_password(password: str) -> str:
    return argon2.using(
        type="ID", time_cost=3, memory_cost=64 * 1024, parallelism=1
    ).hash(_peppered(password))


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return argon2.verify(_peppered(password), password_hash)
    except (ValueError, TypeError):
        return False
