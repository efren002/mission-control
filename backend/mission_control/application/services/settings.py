from __future__ import annotations

import json
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.infrastructure.database.models import SystemSetting

WORKFLOW_SETTINGS_KEY = "workflow_settings"
WORKFLOW_DEFAULTS: dict[str, Any] = {
    "planner_provider": "codex",
    "planner_model": None,
    "require_plan_approval": True,
    "require_execution_approval": True,
    "auto_assign_tasks": True,
    "max_planning_tasks": 20,
    "provider_timeout_seconds": 1800,
    "allow_repository_writes": False,
    "retain_invocation_output": True,
}


async def get_workflow_settings(session: AsyncSession) -> dict[str, Any]:
    setting = await session.get(SystemSetting, WORKFLOW_SETTINGS_KEY)
    if setting is None:
        return dict(WORKFLOW_DEFAULTS)
    try:
        stored = json.loads(setting.value)
    except (TypeError, json.JSONDecodeError):
        stored = {}
    if not isinstance(stored, dict):
        stored = {}
    return {
        key: stored.get(key, default)
        for key, default in WORKFLOW_DEFAULTS.items()
    }


async def save_workflow_settings(session: AsyncSession, values: dict[str, Any]) -> dict[str, Any]:
    normalized = {**WORKFLOW_DEFAULTS, **values}
    setting = await session.get(SystemSetting, WORKFLOW_SETTINGS_KEY)
    encoded = json.dumps(normalized, separators=(",", ":"), sort_keys=True)
    if setting is None:
        session.add(SystemSetting(key=WORKFLOW_SETTINGS_KEY, value=encoded))
    else:
        setting.value = encoded
    await session.commit()
    return normalized
