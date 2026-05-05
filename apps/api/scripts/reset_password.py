#!/usr/bin/env python3
"""Admin CLI to reset a user's password (when self-service flow is unavailable).

Usage (run inside the api container):

    docker compose exec api python -m scripts.reset_password \
        --email you@example.com \
        --password 'NewStrongPassw0rd!'

If --password is omitted, you'll be prompted (input is hidden).
Pass --list to print all user emails (no changes) and exit.

The script never prints the new password back. It refuses to modify
soft-deleted users — restore the row first if needed.
"""
from __future__ import annotations

import argparse
import getpass
import sys

from sqlalchemy import select

from carve_api.auth.models import User
from carve_api.auth.passwords import hash_password
from carve_api.db import SessionLocal


def main() -> int:
    parser = argparse.ArgumentParser(description="Reset a user's password.")
    parser.add_argument("--email", help="User email")
    parser.add_argument(
        "--password",
        default=None,
        help="New password (omit to be prompted securely)",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List user emails (no password change) and exit",
    )
    args = parser.parse_args()

    with SessionLocal() as db:
        if args.list:
            rows = db.execute(
                select(User.email, User.role, User.deleted_at)
            ).all()
            for r in rows:
                deleted = " [deleted]" if r.deleted_at else ""
                print(f"  {r.email}  ({r.role.value}){deleted}")
            return 0

        if not args.email:
            parser.error("--email is required (or use --list to see existing users)")

        user = db.execute(
            select(User).where(User.email == args.email.strip().lower())
        ).scalar_one_or_none()
        if user is None:
            print(f"error: no user with email {args.email!r}", file=sys.stderr)
            return 2
        if user.deleted_at is not None:
            print(
                f"error: user {args.email!r} is soft-deleted; restore the row first",
                file=sys.stderr,
            )
            return 3

        new_password = args.password or getpass.getpass("New password: ")
        if len(new_password) < 8:
            print("error: password must be at least 8 characters", file=sys.stderr)
            return 4

        user.password_hash = hash_password(new_password)
        db.commit()
        print(f"ok: password reset for {user.email}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
