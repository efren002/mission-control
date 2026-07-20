from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.infrastructure.database.models import (
    Agent,
    AgentInvocation,
    ConflictResolutionAttempt,
)

DEFAULT_AGENT_PROFILES: tuple[dict[str, str], ...] = (
    {
        "name": "Lead Planner",
        "role": "planner",
        "instructions": (
            "Break the objective into small, ordered, independently verifiable tasks. "
            "Prefer reversible steps and call out risks or open questions in task descriptions."
        ),
    },
    {
        "name": "Senior Developer",
        "role": "developer",
        "instructions": (
            "Implement the assigned task with minimal, focused changes. "
            "Follow the project's existing structure and conventions, and keep the "
            "working tree consistent after every task."
        ),
    },
    {
        "name": "QA Engineer",
        "role": "qa",
        "instructions": (
            "Verify completed work against the task's acceptance criteria. "
            "Run the project's tests where available and report concrete failures."
        ),
    },
    {
        "name": "Code Reviewer",
        "role": "reviewer",
        "instructions": (
            "Review changes for correctness, maintainability, and adherence to the "
            "project standards. Flag defects with specific files and lines."
        ),
    },
)


class AgentService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def seed_defaults(self) -> int:
        """Create the default agent roster when no agents exist yet.

        Idempotent: a non-empty roster (including one the user pruned) is left
        untouched. Returns the number of agents created.
        """
        existing = await self.session.scalar(select(Agent.id).limit(1))
        if existing is not None:
            return 0
        for profile in DEFAULT_AGENT_PROFILES:
            self.session.add(
                Agent(
                    name=profile["name"],
                    role=profile["role"],
                    provider="claude",
                    model=None,
                    instructions=profile["instructions"],
                    enabled=True,
                )
            )
        try:
            await self.session.commit()
        except IntegrityError:
            # A concurrent process seeded first; the roster already exists.
            await self.session.rollback()
            return 0
        return len(DEFAULT_AGENT_PROFILES)

    async def list(self) -> list[Agent]:
        result = await self.session.scalars(select(Agent).order_by(Agent.role, Agent.name))
        return list(result)

    async def get(self, agent_id: uuid.UUID) -> Agent:
        agent = await self.session.get(Agent, agent_id)
        if agent is None:
            raise LookupError("Agent not found")
        return agent

    async def create(
        self,
        *,
        name: str,
        role: str,
        provider: str,
        model: str | None,
        instructions: str,
        enabled: bool,
    ) -> Agent:
        agent = Agent(
            name=name.strip(),
            role=role,
            provider=provider,
            model=model.strip() if model else None,
            instructions=instructions.strip(),
            enabled=enabled,
        )
        self.session.add(agent)
        try:
            await self.session.commit()
        except IntegrityError as error:
            await self.session.rollback()
            raise ValueError("An agent with this name already exists") from error
        await self.session.refresh(agent)
        return agent

    async def update(self, agent_id: uuid.UUID, values: dict[str, object]) -> Agent:
        agent = await self.get(agent_id)
        for field, value in values.items():
            if field in {"name", "model", "instructions"} and isinstance(value, str):
                value = value.strip() or (None if field == "model" else "")
            setattr(agent, field, value)
        try:
            await self.session.commit()
        except IntegrityError as error:
            await self.session.rollback()
            raise ValueError("An agent with this name already exists") from error
        await self.session.refresh(agent)
        return agent

    async def delete(self, agent_id: uuid.UUID) -> None:
        await self.get(agent_id)
        has_resolution_history = await self.session.scalar(
            select(ConflictResolutionAttempt.id)
            .where(ConflictResolutionAttempt.agent_id == agent_id)
            .limit(1)
        )
        if has_resolution_history is not None:
            raise ValueError(
                "This agent has conflict-resolution evidence and cannot be deleted; "
                "disable it instead"
            )
        await self.session.execute(delete(Agent).where(Agent.id == agent_id))
        await self.session.commit()

    async def invocations(
        self, agent_id: uuid.UUID, limit: int = 50
    ) -> Sequence[AgentInvocation]:
        await self.get(agent_id)
        result = await self.session.scalars(
            select(AgentInvocation)
            .where(AgentInvocation.agent_id == agent_id)
            .order_by(AgentInvocation.created_at.desc())
            .limit(limit)
        )
        return list(result)
