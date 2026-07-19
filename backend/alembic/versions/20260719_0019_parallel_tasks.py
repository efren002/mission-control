"""Track dependency-aware isolated task execution.

Revision ID: 20260719_0019
Revises: 20260719_0018
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260719_0019"
down_revision: str | None = "20260719_0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("position", sa.Integer()))
    op.execute(
        """
        WITH ordered AS (
            SELECT id, row_number() OVER (
                PARTITION BY run_id ORDER BY created_at, id
            ) AS position
            FROM tasks
        )
        UPDATE tasks
        SET position = ordered.position
        FROM ordered
        WHERE tasks.id = ordered.id
        """
    )
    op.alter_column("tasks", "position", nullable=False)
    op.add_column(
        "tasks",
        sa.Column(
            "depends_on_positions",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'::json"),
        ),
    )
    # Existing plans retain their original sequential execution semantics.
    op.execute(
        """
        UPDATE tasks
        SET depends_on_positions = json_build_array(position - 1)
        WHERE position > 1
        """
    )
    op.add_column("tasks", sa.Column("worktree_path", sa.String(length=1000)))
    op.add_column("tasks", sa.Column("worktree_branch", sa.String(length=200)))
    op.add_column("tasks", sa.Column("worktree_status", sa.String(length=40)))
    op.add_column("tasks", sa.Column("baseline_sha", sa.String(length=64)))
    op.add_column("tasks", sa.Column("integration_sha", sa.String(length=64)))
    op.create_check_constraint("ck_tasks_position", "tasks", "position >= 1")
    op.create_check_constraint(
        "ck_tasks_worktree_status",
        "tasks",
        "worktree_status IS NULL OR worktree_status IN "
        "('active', 'preserved', 'integrated', 'cleanup_pending')",
    )
    op.create_unique_constraint(
        "uq_tasks_run_position", "tasks", ["run_id", "position"]
    )
    op.create_index("ix_tasks_worktree_status", "tasks", ["worktree_status"])


def downgrade() -> None:
    op.drop_index("ix_tasks_worktree_status", table_name="tasks")
    op.drop_constraint("uq_tasks_run_position", "tasks", type_="unique")
    op.drop_constraint("ck_tasks_worktree_status", "tasks", type_="check")
    op.drop_constraint("ck_tasks_position", "tasks", type_="check")
    op.drop_column("tasks", "integration_sha")
    op.drop_column("tasks", "baseline_sha")
    op.drop_column("tasks", "worktree_status")
    op.drop_column("tasks", "worktree_branch")
    op.drop_column("tasks", "worktree_path")
    op.drop_column("tasks", "depends_on_positions")
    op.drop_column("tasks", "position")
