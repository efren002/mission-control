"""Persist autonomously discovered maintenance findings.

Revision ID: 20260720_0024
Revises: 20260720_0023
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260720_0024"
down_revision: str | None = "20260720_0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "maintenance_findings",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "schedule_id",
            sa.UUID(),
            sa.ForeignKey("maintenance_schedules.id", ondelete="SET NULL"),
        ),
        sa.Column(
            "project_id",
            sa.UUID(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "repository_id",
            sa.UUID(),
            sa.ForeignKey("repositories.id", ondelete="SET NULL"),
        ),
        sa.Column("detector_kind", sa.String(length=50), nullable=False),
        sa.Column("severity", sa.String(length=20), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("detail", sa.Text()),
        sa.Column(
            "evidence",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'{}'::json"),
        ),
        sa.Column("proposed_objective", sa.JSON()),
        sa.Column(
            "status",
            sa.String(length=30),
            nullable=False,
            server_default=sa.text("'proposed'"),
        ),
        sa.Column("dedupe_key", sa.String(length=300), nullable=False),
        sa.Column(
            "objective_id",
            sa.UUID(),
            sa.ForeignKey("objectives.id", ondelete="SET NULL"),
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True)),
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
            "severity IN ('info', 'low', 'medium', 'high', 'critical')",
            name="ck_maintenance_findings_severity",
        ),
        sa.CheckConstraint(
            "status IN ('proposed', 'dismissed', 'converting', 'converted', 'superseded')",
            name="ck_maintenance_findings_status",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_maintenance_findings_project_id",
        "maintenance_findings",
        ["project_id"],
    )
    op.create_index(
        "ix_maintenance_findings_schedule_id",
        "maintenance_findings",
        ["schedule_id"],
    )
    op.create_index(
        "ix_maintenance_findings_status",
        "maintenance_findings",
        ["status"],
    )
    op.create_index(
        "ix_maintenance_findings_detector_kind",
        "maintenance_findings",
        ["detector_kind"],
    )
    # At most one open finding per signature keeps the inbox free of duplicates,
    # while resolved (converted/dismissed) findings free the signature so a
    # recurring schedule or a persistent problem can surface again.
    op.create_index(
        "uq_maintenance_findings_live_signature",
        "maintenance_findings",
        ["project_id", "detector_kind", "dedupe_key"],
        unique=True,
        postgresql_where=sa.text("status IN ('proposed', 'converting')"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_maintenance_findings_live_signature",
        table_name="maintenance_findings",
    )
    op.drop_index(
        "ix_maintenance_findings_detector_kind",
        table_name="maintenance_findings",
    )
    op.drop_index(
        "ix_maintenance_findings_status", table_name="maintenance_findings"
    )
    op.drop_index(
        "ix_maintenance_findings_schedule_id",
        table_name="maintenance_findings",
    )
    op.drop_index(
        "ix_maintenance_findings_project_id",
        table_name="maintenance_findings",
    )
    op.drop_table("maintenance_findings")
