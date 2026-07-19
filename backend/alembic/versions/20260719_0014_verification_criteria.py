"""Add acceptance criteria and verification evidence.

Revision ID: 20260719_0014
Revises: 20260719_0013
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260719_0014"
down_revision: str | None = "20260719_0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "verification_criteria",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=40), server_default="pending", nullable=False),
        sa.Column("evidence", sa.Text(), nullable=True),
        sa.Column("verifier_agent_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
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
            "status IN ('pending', 'passed', 'failed')",
            name="ck_verification_criteria_status",
        ),
        sa.ForeignKeyConstraint(["run_id"], ["runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["verifier_agent_id"], ["agents.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id", "position"),
    )
    op.create_index(
        op.f("ix_verification_criteria_run_id"),
        "verification_criteria",
        ["run_id"],
    )
    op.create_index(
        op.f("ix_verification_criteria_status"),
        "verification_criteria",
        ["status"],
    )
    op.create_index(
        op.f("ix_verification_criteria_verifier_agent_id"),
        "verification_criteria",
        ["verifier_agent_id"],
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_verification_criteria_verifier_agent_id"),
        table_name="verification_criteria",
    )
    op.drop_index(
        op.f("ix_verification_criteria_status"),
        table_name="verification_criteria",
    )
    op.drop_index(
        op.f("ix_verification_criteria_run_id"),
        table_name="verification_criteria",
    )
    op.drop_table("verification_criteria")
