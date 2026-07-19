"""Persist provider token usage per invocation.

Revision ID: 20260719_0017
Revises: 20260719_0016
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260719_0017"
down_revision: str | None = "20260719_0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("agent_invocations", sa.Column("input_tokens", sa.Integer()))
    op.add_column(
        "agent_invocations",
        sa.Column("cached_input_tokens", sa.Integer()),
    )
    op.add_column("agent_invocations", sa.Column("output_tokens", sa.Integer()))
    op.add_column("agent_invocations", sa.Column("total_tokens", sa.Integer()))
    op.create_check_constraint(
        "ck_agent_invocations_nonnegative_tokens",
        "agent_invocations",
        "(input_tokens IS NULL OR input_tokens >= 0) AND "
        "(cached_input_tokens IS NULL OR cached_input_tokens >= 0) AND "
        "(output_tokens IS NULL OR output_tokens >= 0) AND "
        "(total_tokens IS NULL OR total_tokens >= 0)",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_agent_invocations_nonnegative_tokens",
        "agent_invocations",
        type_="check",
    )
    op.drop_column("agent_invocations", "total_tokens")
    op.drop_column("agent_invocations", "output_tokens")
    op.drop_column("agent_invocations", "cached_input_tokens")
    op.drop_column("agent_invocations", "input_tokens")
