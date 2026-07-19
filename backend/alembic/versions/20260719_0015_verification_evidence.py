"""Add run-scoped deterministic verification evidence.

Revision ID: 20260719_0015
Revises: 20260719_0014
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260719_0015"
down_revision: str | None = "20260719_0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "verification_evidence",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.String(length=40), server_default="test", nullable=False),
        sa.Column("status", sa.String(length=40), nullable=False),
        sa.Column("command", sa.Text(), nullable=True),
        sa.Column("exit_code", sa.Integer(), nullable=True),
        sa.Column("output_excerpt", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.CheckConstraint("kind = 'test'", name="ck_verification_evidence_kind"),
        sa.CheckConstraint(
            "status IN ('running', 'passed', 'failed', 'error', 'skipped')",
            name="ck_verification_evidence_status",
        ),
        sa.ForeignKeyConstraint(["run_id"], ["runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id", "kind"),
    )
    op.create_index(
        op.f("ix_verification_evidence_run_id"),
        "verification_evidence",
        ["run_id"],
    )
    op.create_index(
        op.f("ix_verification_evidence_status"),
        "verification_evidence",
        ["status"],
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_verification_evidence_status"),
        table_name="verification_evidence",
    )
    op.drop_index(
        op.f("ix_verification_evidence_run_id"),
        table_name="verification_evidence",
    )
    op.drop_table("verification_evidence")
