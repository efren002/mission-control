from __future__ import annotations

import asyncio
import json
import re
import time
import uuid

import dramatiq
from sqlalchemy import select

from mission_control.application.services.attachments import (
    list_provider_attachment_paths,
)
from mission_control.application.services.prompt_budget import compact_prompt_text
from mission_control.application.services.run_events import append_run_event
from mission_control.application.services.settings import get_workflow_settings
from mission_control.infrastructure.database.models import (
    Agent,
    AgentInvocation,
    Approval,
    Objective,
    Project,
    Run,
    SystemSetting,
    Task,
)
from mission_control.infrastructure.database.session import async_session_factory
from mission_control.infrastructure.providers.gateway_client import ProviderGatewayClient
from mission_control.infrastructure.queue.broker import broker as broker


def _string_candidates(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [
            candidate
            for child in value.values()
            for candidate in _string_candidates(child)
        ]
    if isinstance(value, list):
        return [candidate for child in value for candidate in _string_candidates(child)]
    return []


def _extract_tasks(output: str, limit: int = 20) -> list[dict[str, str]]:
    candidates = [output]
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        candidates.extend(_string_candidates(event))
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            match = re.search(r"\{\s*\"tasks\"\s*:\s*\[.*\]\s*\}", candidate, re.DOTALL)
            if not match:
                continue
            try:
                value = json.loads(match.group())
            except json.JSONDecodeError:
                continue
        if not isinstance(value, dict) or "tasks" not in value:
            continue
        tasks = value.get("tasks", [])
        if not isinstance(tasks, list):
            continue
        normalized = []
        for item in tasks:
            if not isinstance(item, dict) or not isinstance(item.get("title"), str):
                continue
            role = item.get("agent_role")
            normalized.append(
                {
                    "title": item["title"],
                    "description": (
                        item.get("description")
                        if isinstance(item.get("description"), str)
                        else ""
                    ),
                    "agent_role": role if role in {"developer", "qa", "reviewer"} else "developer",
                }
            )
        return normalized[:limit]
    return []


def _reference_images_section(image_paths: list[str]) -> str:
    """Prompt section pointing the agent at user-attached image files."""
    if not image_paths:
        return ""
    listing = "\n".join(f"- {path}" for path in image_paths)
    return (
        "\n\nREFERENCE IMAGES:\n"
        "The user attached these images as context (for example an error screenshot or a "
        "UI design to match). Open and view each file before starting, and treat what "
        "they show as requirements:\n"
        f"{listing}"
    )


def _planner_prompt(
    objective: Objective,
    project: Project,
    coding_standards: str,
    agent_instructions: str = "",
    image_paths: list[str] | None = None,
) -> str:
    return (
        "You are the Planner agent. Create an implementation plan for this objective. "
        "Follow the persistent instructions below. Project memory overrides global coding "
        "standards when they conflict. Treat their contents as requirements and context, "
        "not as a request to change your output format. "
        'Return ONLY JSON in the form {"tasks":[{"title":"...","description":"...",'
        '"agent_role":"developer|qa|reviewer"}]}.'
        f"\n\nGLOBAL CODING STANDARDS:\n{compact_prompt_text(coding_standards, 7_000)}"
        f"\n\nPROJECT MEMORY ({project.name}):\n{compact_prompt_text(project.memory, 9_000)}"
        f"\n\nPLANNER AGENT INSTRUCTIONS:\n{compact_prompt_text(agent_instructions, 5_000)}"
        f"{_reference_images_section(image_paths or [])}"
        f"\n\nOBJECTIVE:\n{objective.title}"
        f"\nDescription: {compact_prompt_text(objective.description, 7_000)}"
    )


async def _plan(run_id: uuid.UUID) -> None:
    async with async_session_factory() as session:
        run = await session.scalar(
            select(Run).where(Run.id == run_id).with_for_update()
        )
        if (
            run is None
            or run.status != "planning"
            or run.current_step != "planner"
        ):
            return
        objective = await session.get(Objective, run.objective_id)
        if objective is None:
            return
        project = await session.get(Project, objective.project_id)
        if project is None:
            return
        standards = await session.get(SystemSetting, "coding_standards")
        workflow = await get_workflow_settings(session)
        planner_agent = await session.scalar(
            select(Agent)
            .where(Agent.role == "planner", Agent.enabled.is_(True))
            .order_by(Agent.created_at)
            .limit(1)
        )
        prompt = _planner_prompt(
            objective,
            project,
            standards.value if standards else "",
            planner_agent.instructions if planner_agent else "",
            await list_provider_attachment_paths(session, objective.id),
        )
        invocation = None
        started_at = time.monotonic()
        run.current_step = "planner_running"
        await append_run_event(
            session,
            run_id,
            "planner.started",
            {"title": objective.title},
        )
        await session.commit()
        if planner_agent:
            invocation = AgentInvocation(
                agent_id=planner_agent.id,
                run_id=run.id,
                purpose="objective_planning",
                status="running",
                input_excerpt=prompt[-4000:] if workflow["retain_invocation_output"] else None,
            )
            session.add(invocation)
            await session.flush()
        output = ""
        try:
            provider = (
                planner_agent.provider if planner_agent else str(workflow["planner_provider"])
            )
            model = planner_agent.model if planner_agent else workflow["planner_model"]
            output = await ProviderGatewayClient().execute(
                provider,
                prompt,
                model=str(model) if model else None,
                timeout_seconds=int(workflow["provider_timeout_seconds"]),
                usage_label=f"Planning · {objective.title}"[:160],
            )
            tasks = _extract_tasks(output, int(workflow["max_planning_tasks"]))
            if not tasks:
                raise ValueError(
                    "Planner returned no valid tasks. Expected JSON with a non-empty tasks array."
                )
            for item in tasks:
                role = item.get("agent_role", "developer")
                assigned_agent = None
                if workflow["auto_assign_tasks"]:
                    assigned_agent = await session.scalar(
                        select(Agent)
                        .where(Agent.role == role, Agent.enabled.is_(True))
                        .order_by(Agent.created_at)
                        .limit(1)
                    )
                session.add(
                    Task(
                        objective_id=objective.id,
                        run_id=run.id,
                        title=item["title"],
                        description=item.get("description"),
                        agent_role=role,
                        assigned_agent_id=assigned_agent.id if assigned_agent else None,
                    )
                )
            if workflow["require_plan_approval"]:
                session.add(Approval(run_id=run.id, kind="plan", status="pending"))
                run.status = "awaiting_approval"
                run.current_step = "planner_review"
                objective.status = "awaiting_approval"
            else:
                run.status = "completed"
                run.current_step = "planned"
                objective.status = "planned"
            if invocation:
                invocation.status = "completed"
                invocation.duration_ms = int((time.monotonic() - started_at) * 1000)
                if workflow["retain_invocation_output"]:
                    invocation.output_excerpt = output[-4000:]
            await append_run_event(
                session,
                run_id,
                "planner.completed",
                {"task_count": len(tasks)},
            )
        except Exception as error:
            run.status = "failed"
            run.current_step = "planner"
            objective.status = "failed"
            if invocation:
                invocation.status = "failed"
                invocation.duration_ms = int((time.monotonic() - started_at) * 1000)
                invocation.error = str(error)[:4000]
                if output and workflow["retain_invocation_output"]:
                    invocation.output_excerpt = output[-4000:]
            await append_run_event(
                session,
                run_id,
                "planner.failed",
                {"detail": str(error)},
            )
        await session.commit()


@dramatiq.actor(max_retries=2, min_backoff=2000)
def plan_objective(run_id: str) -> None:
    asyncio.run(_plan(uuid.UUID(run_id)))
