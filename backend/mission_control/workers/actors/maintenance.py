from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime

import dramatiq
from sqlalchemy import select

from mission_control.application.services.detectors import (
    CommandOutcome,
    DetectorContext,
    DetectorSkipped,
    FindingDraft,
    LlmOutcome,
    get_detector,
)
from mission_control.application.services.detectors.base import (
    CommandRunner,
    LlmRunner,
)
from mission_control.application.services.maintenance import MaintenanceService
from mission_control.application.services.provider_routing import provider_routes
from mission_control.application.services.settings import get_workflow_settings
from mission_control.infrastructure.database.models import (
    Agent,
    AgentInvocation,
    MaintenanceRun,
    MaintenanceSchedule,
    Project,
    Repository,
)
from mission_control.infrastructure.database.session import async_session_factory
from mission_control.infrastructure.providers.gateway_client import (
    ProviderExecutionError,
    ProviderGatewayClient,
    RuntimeGatewayClient,
    provider_workspace,
)
from mission_control.infrastructure.queue.broker import broker as broker

logger = logging.getLogger(__name__)

COMMAND_TIMEOUT_SECONDS = 600
LLM_EXCERPT_CHARS = 4000


def _command_runner(timeout_seconds: int) -> CommandRunner:
    async def run_command(repository: Repository, command: str) -> CommandOutcome:
        try:
            execution = await RuntimeGatewayClient().run_command(
                provider_workspace(repository.path),
                command,
                timeout_seconds=timeout_seconds,
            )
        except Exception as error:
            logger.warning(
                "maintenance_command_failed",
                extra={"command": command[:120]},
                exc_info=True,
            )
            return CommandOutcome(
                exit_code=None, stdout="", stderr=str(error)[:2000], timed_out=False
            )
        return CommandOutcome(
            exit_code=execution.exit_code,
            stdout=execution.stdout,
            stderr=execution.stderr,
            timed_out=execution.timed_out,
        )

    return run_command


def _llm_runner(
    *,
    detector_kind: str,
    agent_id: uuid.UUID | None,
    provider: str,
    model: str | None,
    fallback_enabled: bool,
    timeout_seconds: int,
    retain_output: bool,
) -> LlmRunner:
    async def run_llm(prompt: str) -> LlmOutcome:
        routes = provider_routes(provider, model, fallback_enabled=fallback_enabled)
        last_error: Exception | None = None
        for route in routes:
            try:
                result = await ProviderGatewayClient().execute_result(
                    route.provider,
                    prompt,
                    model=route.model,
                    timeout_seconds=timeout_seconds,
                    access_mode="read-only",
                    usage_label=f"Maintenance · {detector_kind}"[:160],
                )
            except Exception as error:
                last_error = error
                continue
            invocation_id: uuid.UUID | None = None
            if agent_id is not None:
                async with async_session_factory() as session:
                    invocation = AgentInvocation(
                        agent_id=agent_id,
                        purpose=f"maintenance_{detector_kind}"[:120],
                        status="completed",
                        provider=route.provider,
                        model=route.model,
                        attempt=route.attempt,
                        fallback_from_provider=route.fallback_from_provider,
                        routing_reason=route.reason,
                        duration_ms=result.duration_ms,
                        input_tokens=result.input_tokens,
                        cached_input_tokens=result.cached_input_tokens,
                        output_tokens=result.output_tokens,
                        total_tokens=result.total_tokens,
                        input_excerpt=prompt[-LLM_EXCERPT_CHARS:] if retain_output else None,
                        output_excerpt=(
                            result.output[-LLM_EXCERPT_CHARS:] if retain_output else None
                        ),
                    )
                    session.add(invocation)
                    await session.commit()
                    invocation_id = invocation.id
            return LlmOutcome(output=result.output, invocation_id=invocation_id)
        raise last_error or ProviderExecutionError("No provider was available")

    return run_llm


async def _run_detector(maintenance_run_id: uuid.UUID) -> None:
    # Phase 1: load the run context and mark it started.
    async with async_session_factory() as session:
        run = await session.get(MaintenanceRun, maintenance_run_id)
        if run is None or run.status != "running" or run.schedule_id is None:
            return
        schedule = await session.get(MaintenanceSchedule, run.schedule_id)
        if schedule is None or schedule.project_id is None:
            run.status = "failed"
            run.error = "The schedule or its project no longer exists"
            run.finished_at = datetime.now(UTC)
            await session.commit()
            return
        project = await session.get(Project, schedule.project_id)
        if project is None:
            run.status = "failed"
            run.error = "The project no longer exists"
            run.finished_at = datetime.now(UTC)
            await session.commit()
            return
        repositories = list(
            await session.scalars(
                select(Repository).where(Repository.project_id == schedule.project_id)
            )
        )
        agent = await session.scalar(
            select(Agent).where(Agent.enabled.is_(True)).order_by(Agent.created_at).limit(1)
        )
        agent_id = agent.id if agent else None
        agent_provider = agent.provider if agent else None
        agent_model = agent.model if agent else None
        workflow = await get_workflow_settings(session)
        detector_kind = schedule.detector_kind

    provider = agent_provider or str(workflow["planner_provider"])
    model = agent_model or (
        str(workflow["planner_model"]) if workflow["planner_model"] else None
    )
    ctx = DetectorContext(
        project=project,
        repositories=repositories,
        config=dict(schedule.config or {}),
        workflow=workflow,
        run_command=_command_runner(COMMAND_TIMEOUT_SECONDS),
        run_llm=_llm_runner(
            detector_kind=detector_kind,
            agent_id=agent_id,
            provider=provider,
            model=model,
            fallback_enabled=bool(workflow["enable_provider_fallback"]),
            timeout_seconds=int(workflow["provider_timeout_seconds"]),
            retain_output=bool(workflow["retain_invocation_output"]),
        ),
    )

    # Phase 2: run the detector outside any DB transaction.
    status = "succeeded"
    error: str | None = None
    drafts: list[FindingDraft] = []
    try:
        drafts = await get_detector(detector_kind).detect(ctx)
    except DetectorSkipped as skip:
        status = "skipped"
        error = str(skip)[:2000]
    except Exception as failure:
        status = "failed"
        error = str(failure)[:2000]
        logger.warning(
            "maintenance_detector_failed",
            extra={"detector_kind": detector_kind},
            exc_info=True,
        )

    # Phase 3: persist findings and finalize the run + schedule.
    async with async_session_factory() as session:
        run = await session.get(MaintenanceRun, maintenance_run_id)
        if run is None:
            return
        schedule = (
            await session.get(MaintenanceSchedule, run.schedule_id)
            if run.schedule_id
            else None
        )
        created = 0
        if status == "succeeded" and schedule is not None:
            created = await MaintenanceService(session).persist_findings(schedule, drafts)
        run.status = status
        run.error = error
        run.findings_created = created
        run.finished_at = datetime.now(UTC)
        if schedule is not None:
            schedule.last_run_at = datetime.now(UTC)
            schedule.last_status = status
            schedule.last_finding_count = created
        await session.commit()


@dramatiq.actor(max_retries=1, min_backoff=5000)
def run_maintenance_detector(maintenance_run_id: str) -> None:
    asyncio.run(_run_detector(uuid.UUID(maintenance_run_id)))
