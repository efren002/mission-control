"""Add repository display names.

Revision ID: 20260716_0002
Revises: 20260716_0001
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260716_0002"
down_revision: str | None = "20260716_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "repositories",
        sa.Column("name", sa.String(200), nullable=False, server_default="repository"),
    )
    op.alter_column("repositories", "name", server_default=None)


def downgrade() -> None:
    op.drop_column("repositories", "name")
