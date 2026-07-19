"""Add per-project runtime commands and test command runs.

Revision ID: 20260718_0010
Revises: 20260717_0009
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260718_0010"
down_revision: str | None = "20260717_0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("test_command", sa.Text(), nullable=True))
    op.add_column("projects", sa.Column("app_command", sa.Text(), nullable=True))
    op.create_table(
        "command_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("repository_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("kind", sa.String(40), nullable=False),
        sa.Column("command", sa.Text(), nullable=False),
        sa.Column("status", sa.String(40), nullable=False),
        sa.Column("exit_code", sa.Integer(), nullable=True),
        sa.Column("output_excerpt", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["repository_id"], ["repositories.id"], ondelete="SET NULL"),
    )
    op.create_index("ix_command_runs_project_id", "command_runs", ["project_id"])
    op.create_index("ix_command_runs_repository_id", "command_runs", ["repository_id"])
    op.create_index("ix_command_runs_status", "command_runs", ["status"])


def downgrade() -> None:
    op.drop_index("ix_command_runs_status", table_name="command_runs")
    op.drop_index("ix_command_runs_repository_id", table_name="command_runs")
    op.drop_index("ix_command_runs_project_id", table_name="command_runs")
    op.drop_table("command_runs")
    op.drop_column("projects", "app_command")
    op.drop_column("projects", "test_command")
