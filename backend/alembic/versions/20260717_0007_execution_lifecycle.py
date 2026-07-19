"""Add the repository selected for an execution run.

Revision ID: 20260717_0007
Revises: 20260717_0006
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260717_0007"
down_revision: str | None = "20260717_0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "runs",
        sa.Column("repository_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_runs_repository_id_repositories",
        "runs",
        "repositories",
        ["repository_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_runs_repository_id", "runs", ["repository_id"])


def downgrade() -> None:
    op.drop_index("ix_runs_repository_id", table_name="runs")
    op.drop_constraint("fk_runs_repository_id_repositories", "runs", type_="foreignkey")
    op.drop_column("runs", "repository_id")
