"""Record provider routing decisions on agent invocations.

Revision ID: 20260719_0016
Revises: 20260719_0015
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260719_0016"
down_revision: str | None = "20260719_0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("agent_invocations", sa.Column("provider", sa.String(length=40)))
    op.add_column("agent_invocations", sa.Column("model", sa.String(length=120)))
    op.add_column(
        "agent_invocations",
        sa.Column("attempt", sa.Integer(), server_default="1", nullable=False),
    )
    op.add_column(
        "agent_invocations",
        sa.Column("fallback_from_provider", sa.String(length=40)),
    )
    op.add_column(
        "agent_invocations",
        sa.Column("routing_reason", sa.String(length=250)),
    )
    op.create_check_constraint(
        "ck_agent_invocations_provider",
        "agent_invocations",
        "provider IS NULL OR provider IN ('codex', 'claude')",
    )
    op.create_check_constraint(
        "ck_agent_invocations_fallback_provider",
        "agent_invocations",
        "fallback_from_provider IS NULL OR fallback_from_provider IN ('codex', 'claude')",
    )
    op.create_check_constraint(
        "ck_agent_invocations_attempt",
        "agent_invocations",
        "attempt >= 1",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_agent_invocations_attempt",
        "agent_invocations",
        type_="check",
    )
    op.drop_constraint(
        "ck_agent_invocations_fallback_provider",
        "agent_invocations",
        type_="check",
    )
    op.drop_constraint(
        "ck_agent_invocations_provider",
        "agent_invocations",
        type_="check",
    )
    op.drop_column("agent_invocations", "routing_reason")
    op.drop_column("agent_invocations", "fallback_from_provider")
    op.drop_column("agent_invocations", "attempt")
    op.drop_column("agent_invocations", "model")
    op.drop_column("agent_invocations", "provider")
