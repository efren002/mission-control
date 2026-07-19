"""Record detector executions for continuous operations.

Revision ID: 20260720_0025
Revises: 20260720_0024
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260720_0025"
down_revision: str | None = "20260720_0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "maintenance_runs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "schedule_id",
            sa.UUID(),
            sa.ForeignKey("maintenance_schedules.id", ondelete="SET NULL"),
        ),
        sa.Column("detector_kind", sa.String(length=50), nullable=False),
        sa.Column(
            "project_id",
            sa.UUID(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
        ),
        sa.Column(
            "status",
            sa.String(length=40),
            nullable=False,
            server_default=sa.text("'running'"),
        ),
        sa.Column(
            "findings_created",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
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
            "status IN ('running', 'succeeded', 'failed', 'skipped')",
            name="ck_maintenance_runs_status",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_maintenance_runs_schedule_id",
        "maintenance_runs",
        ["schedule_id"],
    )
    op.create_index(
        "ix_maintenance_runs_status",
        "maintenance_runs",
        ["status"],
    )
    op.create_index(
        "uq_maintenance_runs_active_schedule",
        "maintenance_runs",
        ["schedule_id"],
        unique=True,
        postgresql_where=sa.text("status = 'running' AND schedule_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_maintenance_runs_active_schedule", table_name="maintenance_runs"
    )
    op.drop_index("ix_maintenance_runs_status", table_name="maintenance_runs")
    op.drop_index(
        "ix_maintenance_runs_schedule_id", table_name="maintenance_runs"
    )
    op.drop_table("maintenance_runs")
