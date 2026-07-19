"""Add assisted task conflict resolution attempts.

Revision ID: 20260720_0021
Revises: 20260720_0020
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260720_0021"
down_revision: str | None = "20260720_0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "conflict_resolution_attempts",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "task_id",
            sa.UUID(),
            sa.ForeignKey("tasks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "run_id",
            sa.UUID(),
            sa.ForeignKey("runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "agent_id",
            sa.UUID(),
            sa.ForeignKey("agents.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "invocation_id",
            sa.UUID(),
            sa.ForeignKey("agent_invocations.id", ondelete="SET NULL"),
        ),
        sa.Column("status", sa.String(length=40), nullable=False),
        sa.Column("instructions", sa.Text(), nullable=False),
        sa.Column("source_head", sa.String(length=64)),
        sa.Column("branch_before_sha", sa.String(length=64)),
        sa.Column("resolution_sha", sa.String(length=64)),
        sa.Column(
            "conflict_files",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'::json"),
        ),
        sa.Column("test_command", sa.Text()),
        sa.Column("test_status", sa.String(length=40), nullable=False),
        sa.Column("test_exit_code", sa.Integer()),
        sa.Column("test_output_excerpt", sa.Text()),
        sa.Column("error", sa.Text()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'running', 'passed', 'failed')",
            name="ck_conflict_resolution_attempts_status",
        ),
        sa.CheckConstraint(
            "test_status IN ('pending', 'running', 'passed', 'failed', 'error', 'skipped')",
            name="ck_conflict_resolution_attempts_test_status",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_conflict_resolution_attempts_task_id",
        "conflict_resolution_attempts",
        ["task_id"],
    )
    op.create_index(
        "ix_conflict_resolution_attempts_run_id",
        "conflict_resolution_attempts",
        ["run_id"],
    )
    op.create_index(
        "ix_conflict_resolution_attempts_agent_id",
        "conflict_resolution_attempts",
        ["agent_id"],
    )
    op.create_index(
        "ix_conflict_resolution_attempts_invocation_id",
        "conflict_resolution_attempts",
        ["invocation_id"],
    )
    op.create_index(
        "ix_conflict_resolution_attempts_status",
        "conflict_resolution_attempts",
        ["status"],
    )
    op.create_index(
        "ix_conflict_resolution_attempts_test_status",
        "conflict_resolution_attempts",
        ["test_status"],
    )
    op.create_index(
        "uq_conflict_resolution_attempts_active_task",
        "conflict_resolution_attempts",
        ["task_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'running')"),
    )


def downgrade() -> None:
    op.drop_table("conflict_resolution_attempts")
