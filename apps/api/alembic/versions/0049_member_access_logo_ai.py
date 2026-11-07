"""Logo AI's member switch becomes one of the per-tool member settings.

Revision ID: 0049
Revises: 0048
Create Date: 2026-11-01

``LOGO_AI_ALLOW_MEMBERS`` (on/off) is replaced in Settings → Configuration
by ``MEMBERS_LOGO_AI`` (admins only / tasks opened for members / every
task), like the new SAM, My model and Smart Find settings. A value saved
under the old name is carried over so nothing changes for members.
Values are stored as JSON, as the app saves them.
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0049"
down_revision: str | None = "0048"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO app_settings (key, value, encrypted, updated_by, updated_at)
        SELECT 'MEMBERS_LOGO_AI',
               CASE WHEN value = 'true' THEN '"opened_tasks"' ELSE '"admins"' END,
               false, updated_by, updated_at
          FROM app_settings
         WHERE key = 'LOGO_AI_ALLOW_MEMBERS'
        ON CONFLICT (key) DO NOTHING
        """
    )
    op.execute("DELETE FROM app_settings WHERE key = 'LOGO_AI_ALLOW_MEMBERS'")


def downgrade() -> None:
    op.execute(
        """
        INSERT INTO app_settings (key, value, encrypted, updated_by, updated_at)
        SELECT 'LOGO_AI_ALLOW_MEMBERS',
               CASE WHEN value = '"admins"' THEN 'false' ELSE 'true' END,
               false, updated_by, updated_at
          FROM app_settings
         WHERE key = 'MEMBERS_LOGO_AI'
        ON CONFLICT (key) DO NOTHING
        """
    )
    op.execute("DELETE FROM app_settings WHERE key LIKE 'MEMBERS\\_%'")
