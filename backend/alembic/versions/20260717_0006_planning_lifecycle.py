"""Complete planning history and approval metadata.

Revision ID: 20260717_0006
Revises: 20260717_0005
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260717_0006"
down_revision: str | None = "20260717_0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column("run_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_tasks_run_id_runs",
        "tasks",
        "runs",
        ["run_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_tasks_run_id", "tasks", ["run_id"])
    op.add_column("agent_invocations", sa.Column("input_excerpt", sa.Text(), nullable=True))
    op.add_column("approvals", sa.Column("decision_reason", sa.Text(), nullable=True))
    op.add_column(
        "approvals",
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
    )

    connection = op.get_bind()
    # Older zero-task runs were incorrectly marked as awaiting approval.
    empty_runs = connection.execute(
        sa.text(
            """
            SELECT r.id, r.objective_id
            FROM runs r
            WHERE r.status = 'awaiting_approval'
              AND NOT EXISTS (
                SELECT 1 FROM tasks t WHERE t.objective_id = r.objective_id
              )
            """
        )
    ).fetchall()
    for run_id, objective_id in empty_runs:
        connection.execute(
            sa.text(
                "UPDATE runs SET status = 'failed', current_step = 'planner', "
                "updated_at = now() WHERE id = :run_id"
            ),
            {"run_id": run_id},
        )
        connection.execute(
            sa.text(
                "UPDATE objectives SET status = 'failed', updated_at = now() "
                "WHERE id = :objective_id"
            ),
            {"objective_id": objective_id},
        )

    # Associate existing tasks with the most recent run for their objective.
    connection.execute(
        sa.text(
            """
            UPDATE tasks t
            SET run_id = latest.id
            FROM (
                SELECT DISTINCT ON (objective_id) id, objective_id
                FROM runs
                ORDER BY objective_id, created_at DESC
            ) latest
            WHERE latest.objective_id = t.objective_id
            """
        )
    )

    valid_runs = connection.execute(
        sa.text(
            """
            SELECT r.id
            FROM runs r
            WHERE r.status = 'awaiting_approval'
              AND EXISTS (SELECT 1 FROM tasks t WHERE t.run_id = r.id)
              AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = r.id)
            """
        )
    ).fetchall()
    approvals = sa.table(
        "approvals",
        sa.column("id", postgresql.UUID(as_uuid=True)),
        sa.column("run_id", postgresql.UUID(as_uuid=True)),
        sa.column("kind", sa.String()),
        sa.column("status", sa.String()),
    )
    if valid_runs:
        op.bulk_insert(
            approvals,
            [
                {
                    "id": uuid.uuid4(),
                    "run_id": run_id,
                    "kind": "plan",
                    "status": "pending",
                }
                for (run_id,) in valid_runs
            ],
        )


def downgrade() -> None:
    op.drop_column("approvals", "decided_at")
    op.drop_column("approvals", "decision_reason")
    op.drop_column("agent_invocations", "input_excerpt")
    op.drop_index("ix_tasks_run_id", table_name="tasks")
    op.drop_constraint("fk_tasks_run_id_runs", "tasks", type_="foreignkey")
    op.drop_column("tasks", "run_id")
