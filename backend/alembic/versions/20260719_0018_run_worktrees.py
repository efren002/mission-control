"""Track isolated Git worktrees for execution runs.

Revision ID: 20260719_0018
Revises: 20260719_0017
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260719_0018"
down_revision: str | None = "20260719_0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("runs", sa.Column("worktree_path", sa.String(length=1000)))
    op.add_column("runs", sa.Column("worktree_branch", sa.String(length=200)))
    op.add_column("runs", sa.Column("worktree_status", sa.String(length=40)))
    op.add_column("runs", sa.Column("baseline_sha", sa.String(length=64)))
    op.add_column("runs", sa.Column("integration_sha", sa.String(length=64)))
    op.create_check_constraint(
        "ck_runs_worktree_status",
        "runs",
        "worktree_status IS NULL OR worktree_status IN "
        "('active', 'preserved', 'integrated', 'cleanup_pending')",
    )
    op.create_index("ix_runs_worktree_status", "runs", ["worktree_status"])


def downgrade() -> None:
    op.drop_index("ix_runs_worktree_status", table_name="runs")
    op.drop_constraint("ck_runs_worktree_status", "runs", type_="check")
    op.drop_column("runs", "integration_sha")
    op.drop_column("runs", "baseline_sha")
    op.drop_column("runs", "worktree_status")
    op.drop_column("runs", "worktree_branch")
    op.drop_column("runs", "worktree_path")
