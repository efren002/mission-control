from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from mission_control.infrastructure.database.base import Base


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class User(TimestampMixin, Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    username: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)


class Project(TimestampMixin, Base):
    __tablename__ = "projects"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="active")
    memory: Mapped[str] = mapped_column(Text, nullable=False, default="")
    test_command: Mapped[str | None] = mapped_column(Text)
    app_command: Mapped[str | None] = mapped_column(Text)


class SystemSetting(TimestampMixin, Base):
    __tablename__ = "system_settings"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False, default="")


class DispatchJob(TimestampMixin, Base):
    __tablename__ = "dispatch_jobs"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('plan_objective', 'run_project_tests', "
            "'run_maintenance_detector')",
            name="ck_dispatch_jobs_kind",
        ),
        CheckConstraint("attempts >= 0", name="ck_dispatch_jobs_attempts"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    kind: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    dedupe_key: Mapped[str] = mapped_column(String(160), unique=True, nullable=False)
    payload: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False, default=dict)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)


class Repository(TimestampMixin, Base):
    __tablename__ = "repositories"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    path: Mapped[str] = mapped_column(Text, nullable=False)
    default_branch: Mapped[str] = mapped_column(String(200), nullable=False, default="main")


class Objective(TimestampMixin, Base):
    __tablename__ = "objectives"
    __table_args__ = (
        CheckConstraint(
            "status IN ('draft', 'planning', 'awaiting_approval', 'planned', "
            "'awaiting_execution_approval', 'executing', 'completed', 'failed', 'rejected')",
            name="ck_objectives_status",
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=False
    )
    title: Mapped[str] = mapped_column(String(250), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="draft", index=True)


class ObjectiveAttachment(TimestampMixin, Base):
    __tablename__ = "objective_attachments"
    __table_args__ = (
        CheckConstraint("size_bytes > 0", name="ck_objective_attachments_size"),
        CheckConstraint(
            "content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')",
            name="ck_objective_attachments_content_type",
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    objective_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("objectives.id", ondelete="CASCADE"), index=True, nullable=False
    )
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)


class Agent(TimestampMixin, Base):
    __tablename__ = "agents"
    __table_args__ = (
        CheckConstraint(
            "role IN ('planner', 'developer', 'qa', 'reviewer')",
            name="ck_agents_role",
        ),
        # Provider name constraint dropped in migration 20260720_0027 to allow
        # custom HTTP providers; role/kind validation now lives in the app layer.
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    role: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    provider: Mapped[str] = mapped_column(String(40), nullable=False, default="codex")
    model: Mapped[str | None] = mapped_column(String(120))
    instructions: Mapped[str] = mapped_column(Text, nullable=False, default="")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)


class Task(TimestampMixin, Base):
    __tablename__ = "tasks"
    __table_args__ = (
        CheckConstraint(
            "status IN ('planned', 'queued', 'in_progress', 'completed', "
            "'failed', 'blocked', 'rejected', 'reverted')",
            name="ck_tasks_status",
        ),
        CheckConstraint(
            "agent_role IN ('developer', 'qa', 'reviewer')",
            name="ck_tasks_agent_role",
        ),
        CheckConstraint("position >= 1", name="ck_tasks_position"),
        CheckConstraint(
            "worktree_status IS NULL OR worktree_status IN "
            "('active', 'preserved', 'integrated', 'cleanup_pending')",
            name="ck_tasks_worktree_status",
        ),
        UniqueConstraint("run_id", "position", name="uq_tasks_run_position"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    objective_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("objectives.id", ondelete="CASCADE"), index=True, nullable=False
    )
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("runs.id", ondelete="SET NULL"), index=True
    )
    title: Mapped[str] = mapped_column(String(250), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    depends_on_positions: Mapped[list[int]] = mapped_column(
        JSON, nullable=False, default=list
    )
    predicted_files: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="planned", index=True)
    agent_role: Mapped[str] = mapped_column(String(80), nullable=False, default="developer")
    assigned_agent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("agents.id", ondelete="SET NULL"), index=True
    )
    checkpoint_sha: Mapped[str | None] = mapped_column(String(64))
    worktree_path: Mapped[str | None] = mapped_column(String(1000))
    worktree_branch: Mapped[str | None] = mapped_column(String(200))
    worktree_status: Mapped[str | None] = mapped_column(String(40), index=True)
    baseline_sha: Mapped[str | None] = mapped_column(String(64))
    integration_sha: Mapped[str | None] = mapped_column(String(64))
    conflict_files: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    conflict_detail: Mapped[str | None] = mapped_column(Text)
    conflict_detected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ConflictResolutionAttempt(TimestampMixin, Base):
    __tablename__ = "conflict_resolution_attempts"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued', 'running', 'passed', 'failed')",
            name="ck_conflict_resolution_attempts_status",
        ),
        CheckConstraint(
            "test_status IN ('pending', 'running', 'passed', 'failed', 'error', 'skipped')",
            name="ck_conflict_resolution_attempts_test_status",
        ),
        Index(
            "uq_conflict_resolution_attempts_active_task",
            "task_id",
            unique=True,
            postgresql_where=text("status IN ('queued', 'running')"),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), index=True, nullable=False
    )
    run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), index=True, nullable=False
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("agents.id", ondelete="RESTRICT"), index=True, nullable=False
    )
    invocation_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("agent_invocations.id", ondelete="SET NULL"), index=True
    )
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="queued", index=True)
    instructions: Mapped[str] = mapped_column(Text, nullable=False, default="")
    source_head: Mapped[str | None] = mapped_column(String(64))
    branch_before_sha: Mapped[str | None] = mapped_column(String(64))
    resolution_sha: Mapped[str | None] = mapped_column(String(64))
    conflict_files: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    test_command: Mapped[str | None] = mapped_column(Text)
    test_status: Mapped[str] = mapped_column(
        String(40), nullable=False, default="pending", index=True
    )
    test_exit_code: Mapped[int | None] = mapped_column(Integer)
    test_output_excerpt: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class VerificationCriterion(TimestampMixin, Base):
    __tablename__ = "verification_criteria"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'passed', 'failed')",
            name="ck_verification_criteria_status",
        ),
        UniqueConstraint("run_id", "position"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), index=True, nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="pending", index=True)
    evidence: Mapped[str | None] = mapped_column(Text)
    verifier_agent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("agents.id", ondelete="SET NULL"), index=True
    )
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class VerificationEvidence(TimestampMixin, Base):
    __tablename__ = "verification_evidence"
    __table_args__ = (
        CheckConstraint("kind = 'test'", name="ck_verification_evidence_kind"),
        CheckConstraint(
            "status IN ('running', 'passed', 'failed', 'error', 'skipped')",
            name="ck_verification_evidence_status",
        ),
        UniqueConstraint("run_id", "kind"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), index=True, nullable=False
    )
    kind: Mapped[str] = mapped_column(String(40), nullable=False, default="test")
    status: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    command: Mapped[str | None] = mapped_column(Text)
    exit_code: Mapped[int | None] = mapped_column(Integer)
    output_excerpt: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Run(TimestampMixin, Base):
    __tablename__ = "runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued', 'planning', 'awaiting_approval', 'completed', "
            "'rejected', 'awaiting_execution_approval', 'queued_for_execution', "
            "'executing', 'failed')",
            name="ck_runs_status",
        ),
        CheckConstraint(
            "worktree_status IS NULL OR worktree_status IN "
            "('active', 'preserved', 'integrated', 'cleanup_pending')",
            name="ck_runs_worktree_status",
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    objective_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("objectives.id", ondelete="CASCADE"), index=True, nullable=False
    )
    repository_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("repositories.id", ondelete="SET NULL"), index=True
    )
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="queued", index=True)
    current_step: Mapped[str | None] = mapped_column(String(100))
    worktree_path: Mapped[str | None] = mapped_column(String(1000))
    worktree_branch: Mapped[str | None] = mapped_column(String(200))
    worktree_status: Mapped[str | None] = mapped_column(String(40), index=True)
    baseline_sha: Mapped[str | None] = mapped_column(String(64))
    integration_sha: Mapped[str | None] = mapped_column(String(64))


class AgentInvocation(TimestampMixin, Base):
    __tablename__ = "agent_invocations"
    __table_args__ = (
        CheckConstraint(
            "status IN ('running', 'completed', 'failed')",
            name="ck_agent_invocations_status",
        ),
        # Provider name constraints dropped in migration 20260720_0027 to allow
        # custom HTTP providers; role/kind validation now lives in the app layer.
        CheckConstraint("attempt >= 1", name="ck_agent_invocations_attempt"),
        CheckConstraint(
            "(input_tokens IS NULL OR input_tokens >= 0) AND "
            "(cached_input_tokens IS NULL OR cached_input_tokens >= 0) AND "
            "(output_tokens IS NULL OR output_tokens >= 0) AND "
            "(total_tokens IS NULL OR total_tokens >= 0)",
            name="ck_agent_invocations_nonnegative_tokens",
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("agents.id", ondelete="CASCADE"), index=True, nullable=False
    )
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("runs.id", ondelete="SET NULL"), index=True
    )
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tasks.id", ondelete="SET NULL"), index=True
    )
    finding_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("maintenance_findings.id", ondelete="SET NULL"), index=True
    )
    purpose: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="running", index=True)
    provider: Mapped[str | None] = mapped_column(String(40))
    model: Mapped[str | None] = mapped_column(String(120))
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    fallback_from_provider: Mapped[str | None] = mapped_column(String(40))
    routing_reason: Mapped[str | None] = mapped_column(String(250))
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    cached_input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    total_tokens: Mapped[int | None] = mapped_column(Integer)
    input_excerpt: Mapped[str | None] = mapped_column(Text)
    output_excerpt: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)


class CommandRun(TimestampMixin, Base):
    __tablename__ = "command_runs"
    __table_args__ = (
        CheckConstraint("kind = 'test'", name="ck_command_runs_kind"),
        CheckConstraint(
            "status IN ('queued', 'running', 'passed', 'failed', 'error')",
            name="ck_command_runs_status",
        ),
        Index(
            "uq_command_runs_active_repository",
            "repository_id",
            unique=True,
            postgresql_where=text("status IN ('queued', 'running')"),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=False
    )
    repository_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("repositories.id", ondelete="SET NULL"), index=True
    )
    kind: Mapped[str] = mapped_column(String(40), nullable=False, default="test")
    command: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="queued", index=True)
    exit_code: Mapped[int | None] = mapped_column(Integer)
    output_excerpt: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RunEvent(Base):
    __tablename__ = "run_events"
    __table_args__ = (
        UniqueConstraint(
            "run_id",
            "sequence",
            name="uq_run_events_run_id_sequence",
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), index=True, nullable=False
    )
    sequence: Mapped[int] = mapped_column(nullable=False)
    event_type: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    payload: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )


class Approval(TimestampMixin, Base):
    __tablename__ = "approvals"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('plan', 'execution', 'task_integration')",
            name="ck_approvals_kind",
        ),
        CheckConstraint(
            "status IN ('pending', 'approved', 'rejected')",
            name="ck_approvals_status",
        ),
        Index(
            "uq_approvals_pending_run_kind",
            "run_id",
            "kind",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), index=True, nullable=False
    )
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(50), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="pending", index=True)
    decided_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    decision_reason: Mapped[str | None] = mapped_column(Text)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class MaintenanceSchedule(TimestampMixin, Base):
    __tablename__ = "maintenance_schedules"
    __table_args__ = (
        CheckConstraint(
            "detector_kind IN ('dependency_maintenance', 'failing_test_diagnosis', "
            "'documentation_drift', 'issue_triage', 'security_health', "
            "'repo_health', 'mission_template')",
            name="ck_maintenance_schedules_detector_kind",
        ),
        CheckConstraint(
            "interval_seconds >= 60", name="ck_maintenance_schedules_interval"
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    detector_kind: Mapped[str] = mapped_column(String(50), nullable=False)
    interval_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    config: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False, default=dict)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    last_status: Mapped[str | None] = mapped_column(String(40))
    last_finding_count: Mapped[int | None] = mapped_column(Integer)


class MaintenanceFinding(TimestampMixin, Base):
    __tablename__ = "maintenance_findings"
    __table_args__ = (
        CheckConstraint(
            "severity IN ('info', 'low', 'medium', 'high', 'critical')",
            name="ck_maintenance_findings_severity",
        ),
        CheckConstraint(
            "status IN ('proposed', 'dismissed', 'converting', 'converted', 'superseded')",
            name="ck_maintenance_findings_status",
        ),
        Index(
            "uq_maintenance_findings_live_signature",
            "project_id",
            "detector_kind",
            "dedupe_key",
            unique=True,
            postgresql_where=text("status IN ('proposed', 'converting')"),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    schedule_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("maintenance_schedules.id", ondelete="SET NULL"), index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=False
    )
    repository_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("repositories.id", ondelete="SET NULL")
    )
    detector_kind: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    severity: Mapped[str] = mapped_column(String(20), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    detail: Mapped[str | None] = mapped_column(Text)
    evidence: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False, default=dict)
    proposed_objective: Mapped[dict[str, object] | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="proposed", index=True)
    dedupe_key: Mapped[str] = mapped_column(String(300), nullable=False)
    objective_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("objectives.id", ondelete="SET NULL")
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class MaintenanceRun(TimestampMixin, Base):
    __tablename__ = "maintenance_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('running', 'succeeded', 'failed', 'skipped')",
            name="ck_maintenance_runs_status",
        ),
        Index(
            "uq_maintenance_runs_active_schedule",
            "schedule_id",
            unique=True,
            postgresql_where=text("status = 'running' AND schedule_id IS NOT NULL"),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    schedule_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("maintenance_schedules.id", ondelete="SET NULL"), index=True
    )
    detector_kind: Mapped[str] = mapped_column(String(50), nullable=False)
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE")
    )
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="running", index=True)
    findings_created: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
