"""Relax provider check constraints to allow custom HTTP providers.

Drops the CHECK constraints that pinned agents.provider and
agent_invocations.(provider|fallback_from_provider) to ('codex', 'claude') so
HTTP providers declared in the gateway's providers.json (openrouter, 9router,
anthropic-compatible) can be stored. Role/kind validation now lives in the
application layer (see application/services/provider_routing.py and the agents
API).

Downgrade restores the constraints; the operator must first reset any rows
holding custom provider names back to 'codex' (UPDATE agents SET provider='codex'
WHERE provider NOT IN ('codex','claude'); same for agent_invocations columns).

Revision ID: 20260720_0027
Revises: 20260720_0026
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260720_0027"
down_revision: str | None = "20260720_0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (table, constraint_name, column, nullable)
CONSTRAINTS = (
    ("agents", "ck_agents_provider", "provider", False),
    ("agent_invocations", "ck_agent_invocations_provider", "provider", True),
    ("agent_invocations", "ck_agent_invocations_fallback_provider", "fallback_from_provider", True),
)


def upgrade() -> None:
    for table_name, constraint_name, _column, _nullable in CONSTRAINTS:
        op.drop_constraint(constraint_name, table_name, type_="check")


def downgrade() -> None:
    for table_name, constraint_name, column, nullable in CONSTRAINTS:
        clause = sa.text(f"{column} IN ('codex', 'claude')")
        if nullable:
            clause = sa.text(f"{column} IS NULL OR {column} IN ('codex', 'claude')")
        op.create_check_constraint(constraint_name, table_name, clause)
