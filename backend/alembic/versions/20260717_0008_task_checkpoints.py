"""Record the Git checkpoint commit created after each completed task.

Revision ID: 20260717_0008
Revises: 20260717_0007
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260717_0008"
down_revision: str | None = "20260717_0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("checkpoint_sha", sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column("tasks", "checkpoint_sha")
