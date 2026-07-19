"""Persist task conflicts and integration approvals.

Revision ID: 20260720_0020
Revises: 20260719_0019
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260720_0020"
down_revision: str | None = "20260719_0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column(
            "conflict_files",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'::json"),
        ),
    )
    op.add_column("tasks", sa.Column("conflict_detail", sa.Text()))
    op.add_column(
        "tasks", sa.Column("conflict_detected_at", sa.DateTime(timezone=True))
    )
    op.add_column(
        "approvals",
        sa.Column(
            "task_id",
            sa.UUID(),
            sa.ForeignKey("tasks.id", ondelete="CASCADE"),
        ),
    )
    op.create_index("ix_approvals_task_id", "approvals", ["task_id"])
    op.drop_constraint("ck_approvals_kind", "approvals", type_="check")
    op.create_check_constraint(
        "ck_approvals_kind",
        "approvals",
        "kind IN ('plan', 'execution', 'task_integration')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_approvals_kind", "approvals", type_="check")
    op.create_check_constraint(
        "ck_approvals_kind",
        "approvals",
        "kind IN ('plan', 'execution')",
    )
    op.drop_index("ix_approvals_task_id", table_name="approvals")
    op.drop_column("approvals", "task_id")
    op.drop_column("tasks", "conflict_detected_at")
    op.drop_column("tasks", "conflict_detail")
    op.drop_column("tasks", "conflict_files")
