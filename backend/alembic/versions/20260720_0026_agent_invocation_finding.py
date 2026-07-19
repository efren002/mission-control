"""Link agent invocations to maintenance findings for traceability.

Revision ID: 20260720_0026
Revises: 20260720_0025
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260720_0026"
down_revision: str | None = "20260720_0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_invocations",
        sa.Column(
            "finding_id",
            sa.UUID(),
            sa.ForeignKey("maintenance_findings.id", ondelete="SET NULL"),
        ),
    )
    op.create_index(
        "ix_agent_invocations_finding_id",
        "agent_invocations",
        ["finding_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_agent_invocations_finding_id", table_name="agent_invocations"
    )
    op.drop_column("agent_invocations", "finding_id")
