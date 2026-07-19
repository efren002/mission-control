"""Enforce workflow state invariants.

Revision ID: 20260719_0013
Revises: 20260719_0012
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260719_0013"
down_revision: str | None = "20260719_0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_check_constraint(
        "ck_dispatch_jobs_kind",
        "dispatch_jobs",
        "kind IN ('plan_objective', 'run_project_tests')",
    )
    op.create_check_constraint(
        "ck_dispatch_jobs_attempts", "dispatch_jobs", "attempts >= 0"
    )
    op.create_check_constraint(
        "ck_objectives_status",
        "objectives",
        "status IN ('draft', 'planning', 'awaiting_approval', 'planned', "
        "'awaiting_execution_approval', 'executing', 'completed', 'failed', 'rejected')",
    )
    op.create_check_constraint(
        "ck_objective_attachments_size",
        "objective_attachments",
        "size_bytes > 0",
    )
    op.create_check_constraint(
        "ck_objective_attachments_content_type",
        "objective_attachments",
        "content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')",
    )
    op.create_check_constraint(
        "ck_agents_role",
        "agents",
        "role IN ('planner', 'developer', 'qa', 'reviewer')",
    )
    op.create_check_constraint(
        "ck_agents_provider", "agents", "provider IN ('codex', 'claude')"
    )
    op.create_check_constraint(
        "ck_tasks_status",
        "tasks",
        "status IN ('planned', 'queued', 'in_progress', 'completed', "
        "'failed', 'blocked', 'rejected', 'reverted')",
    )
    op.create_check_constraint(
        "ck_tasks_agent_role",
        "tasks",
        "agent_role IN ('developer', 'qa', 'reviewer')",
    )
    op.create_check_constraint(
        "ck_runs_status",
        "runs",
        "status IN ('queued', 'planning', 'awaiting_approval', 'completed', "
        "'rejected', 'awaiting_execution_approval', 'queued_for_execution', "
        "'executing', 'failed')",
    )
    op.create_check_constraint(
        "ck_agent_invocations_status",
        "agent_invocations",
        "status IN ('running', 'completed', 'failed')",
    )
    op.create_check_constraint(
        "ck_command_runs_kind", "command_runs", "kind = 'test'"
    )
    op.create_check_constraint(
        "ck_command_runs_status",
        "command_runs",
        "status IN ('queued', 'running', 'passed', 'failed', 'error')",
    )
    op.create_check_constraint(
        "ck_approvals_kind", "approvals", "kind IN ('plan', 'execution')"
    )
    op.create_check_constraint(
        "ck_approvals_status",
        "approvals",
        "status IN ('pending', 'approved', 'rejected')",
    )
    op.create_index(
        "uq_command_runs_active_repository",
        "command_runs",
        ["repository_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'running')"),
    )
    op.create_index(
        "uq_approvals_pending_run_kind",
        "approvals",
        ["run_id", "kind"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index("uq_approvals_pending_run_kind", table_name="approvals")
    op.drop_index("uq_command_runs_active_repository", table_name="command_runs")
    for table, constraint in (
        ("approvals", "ck_approvals_status"),
        ("approvals", "ck_approvals_kind"),
        ("command_runs", "ck_command_runs_status"),
        ("command_runs", "ck_command_runs_kind"),
        ("agent_invocations", "ck_agent_invocations_status"),
        ("runs", "ck_runs_status"),
        ("tasks", "ck_tasks_agent_role"),
        ("tasks", "ck_tasks_status"),
        ("agents", "ck_agents_provider"),
        ("agents", "ck_agents_role"),
        ("objective_attachments", "ck_objective_attachments_content_type"),
        ("objective_attachments", "ck_objective_attachments_size"),
        ("objectives", "ck_objectives_status"),
        ("dispatch_jobs", "ck_dispatch_jobs_attempts"),
        ("dispatch_jobs", "ck_dispatch_jobs_kind"),
    ):
        op.drop_constraint(constraint, table, type_="check")
