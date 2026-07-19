"""Add continuous-operations maintenance schedules.

Revision ID: 20260720_0023
Revises: 20260720_0022
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260720_0023"
down_revision: str | None = "20260720_0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DETECTOR_KINDS = (
    "dependency_maintenance",
    "failing_test_diagnosis",
    "documentation_drift",
    "issue_triage",
    "security_health",
    "repo_health",
    "mission_template",
)


def upgrade() -> None:
    kinds = ", ".join(f"'{kind}'" for kind in DETECTOR_KINDS)
    op.create_table(
        "maintenance_schedules",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "project_id",
            sa.UUID(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
        ),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("detector_kind", sa.String(length=50), nullable=False),
        sa.Column("interval_seconds", sa.Integer(), nullable=False),
        sa.Column(
            "enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "config",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'{}'::json"),
        ),
        sa.Column("last_run_at", sa.DateTime(timezone=True)),
        sa.Column("next_run_at", sa.DateTime(timezone=True)),
        sa.Column("last_status", sa.String(length=40)),
        sa.Column("last_finding_count", sa.Integer()),
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
            f"detector_kind IN ({kinds})",
            name="ck_maintenance_schedules_detector_kind",
        ),
        sa.CheckConstraint(
            "interval_seconds >= 60",
            name="ck_maintenance_schedules_interval",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_maintenance_schedules_project_id",
        "maintenance_schedules",
        ["project_id"],
    )
    op.create_index(
        "ix_maintenance_schedules_enabled",
        "maintenance_schedules",
        ["enabled"],
    )
    op.create_index(
        "ix_maintenance_schedules_next_run_at",
        "maintenance_schedules",
        ["next_run_at"],
    )
    # The scheduler enqueues detector work through the existing dispatch outbox.
    op.drop_constraint("ck_dispatch_jobs_kind", "dispatch_jobs", type_="check")
    op.create_check_constraint(
        "ck_dispatch_jobs_kind",
        "dispatch_jobs",
        "kind IN ('plan_objective', 'run_project_tests', 'run_maintenance_detector')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_dispatch_jobs_kind", "dispatch_jobs", type_="check")
    op.create_check_constraint(
        "ck_dispatch_jobs_kind",
        "dispatch_jobs",
        "kind IN ('plan_objective', 'run_project_tests')",
    )
    op.drop_index(
        "ix_maintenance_schedules_next_run_at",
        table_name="maintenance_schedules",
    )
    op.drop_index(
        "ix_maintenance_schedules_enabled", table_name="maintenance_schedules"
    )
    op.drop_index(
        "ix_maintenance_schedules_project_id", table_name="maintenance_schedules"
    )
    op.drop_table("maintenance_schedules")
