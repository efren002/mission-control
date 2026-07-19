"""Add configurable agents, task assignments, and invocation history.

Revision ID: 20260717_0005
Revises: 20260716_0004
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260717_0005"
down_revision: str | None = "20260716_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agents",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("role", sa.String(80), nullable=False),
        sa.Column("provider", sa.String(40), nullable=False),
        sa.Column("model", sa.String(120), nullable=True),
        sa.Column("instructions", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_index("ix_agents_role", "agents", ["role"])
    op.create_index("ix_agents_enabled", "agents", ["enabled"])
    agents = sa.table(
        "agents",
        sa.column("id", postgresql.UUID(as_uuid=True)),
        sa.column("name", sa.String()),
        sa.column("role", sa.String()),
        sa.column("provider", sa.String()),
        sa.column("model", sa.String()),
        sa.column("instructions", sa.Text()),
        sa.column("enabled", sa.Boolean()),
    )
    op.bulk_insert(
        agents,
        [
            {
                "id": uuid.UUID("00000000-0000-4000-8000-000000000101"),
                "name": "Mission Planner",
                "role": "planner",
                "provider": "codex",
                "model": None,
                "instructions": "Produce small, verifiable tasks with explicit acceptance checks.",
                "enabled": True,
            },
            {
                "id": uuid.UUID("00000000-0000-4000-8000-000000000102"),
                "name": "Implementation Agent",
                "role": "developer",
                "provider": "codex",
                "model": None,
                "instructions": (
                    "Implement assigned work and preserve existing project conventions."
                ),
                "enabled": True,
            },
            {
                "id": uuid.UUID("00000000-0000-4000-8000-000000000103"),
                "name": "Quality Agent",
                "role": "qa",
                "provider": "codex",
                "model": None,
                "instructions": "Verify acceptance criteria and test changed behavior.",
                "enabled": True,
            },
            {
                "id": uuid.UUID("00000000-0000-4000-8000-000000000104"),
                "name": "Review Agent",
                "role": "reviewer",
                "provider": "codex",
                "model": None,
                "instructions": (
                    "Review correctness, security, maintainability, and regression risk."
                ),
                "enabled": True,
            },
        ],
    )
    op.add_column(
        "tasks", sa.Column("assigned_agent_id", postgresql.UUID(as_uuid=True), nullable=True)
    )
    op.create_foreign_key(
        "fk_tasks_assigned_agent_id_agents",
        "tasks",
        "agents",
        ["assigned_agent_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_tasks_assigned_agent_id", "tasks", ["assigned_agent_id"])
    op.create_table(
        "agent_invocations",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("task_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("purpose", sa.String(120), nullable=False),
        sa.Column("status", sa.String(40), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("output_excerpt", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["run_id"], ["runs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_agent_invocations_agent_id", "agent_invocations", ["agent_id"])
    op.create_index("ix_agent_invocations_run_id", "agent_invocations", ["run_id"])
    op.create_index("ix_agent_invocations_task_id", "agent_invocations", ["task_id"])
    op.create_index("ix_agent_invocations_status", "agent_invocations", ["status"])


def downgrade() -> None:
    op.drop_table("agent_invocations")
    op.drop_index("ix_tasks_assigned_agent_id", table_name="tasks")
    op.drop_constraint("fk_tasks_assigned_agent_id_agents", "tasks", type_="foreignkey")
    op.drop_column("tasks", "assigned_agent_id")
    op.drop_table("agents")
