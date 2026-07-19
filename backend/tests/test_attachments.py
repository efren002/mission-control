import asyncio
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from mission_control.application.services.attachments import (
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS_PER_OBJECTIVE,
    AttachmentService,
    attachment_file_path,
    provider_attachment_path,
    sniff_image_type,
)
from mission_control.core.config import Settings
from mission_control.infrastructure.database.models import Objective, ObjectiveAttachment
from mission_control.workers.actors.executor import _execution_prompt
from mission_control.workers.actors.planner import _planner_prompt

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"payload"


def test_image_type_is_detected_from_file_signatures() -> None:
    assert sniff_image_type(PNG_BYTES) == "image/png"
    assert sniff_image_type(b"\xff\xd8\xff\xe0rest") == "image/jpeg"
    assert sniff_image_type(b"GIF89a-frame") == "image/gif"
    assert sniff_image_type(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
    assert sniff_image_type(b"%PDF-1.7 not an image") is None
    assert sniff_image_type(b"") is None


def _attachment_settings(tmp_path: Path) -> Settings:
    return Settings(
        attachment_root=str(tmp_path / "attachments"),
        provider_attachment_root="/workspaces/attachments",
    )


def _service_session(objective: Objective | None, existing_count: int = 0) -> MagicMock:
    session = MagicMock()
    session.get = AsyncMock(return_value=objective)
    session.scalar = AsyncMock(return_value=existing_count)
    session.add = MagicMock(side_effect=lambda item: setattr(item, "id", uuid.uuid4()))
    session.flush = AsyncMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    return session


def test_upload_stores_the_image_where_the_provider_gateway_can_read_it(
    tmp_path: Path,
) -> None:
    settings = _attachment_settings(tmp_path)
    objective = Objective(id=uuid.uuid4(), project_id=uuid.uuid4(), title="Fix the error")
    service = AttachmentService(_service_session(objective), settings)

    attachment = asyncio.run(service.create(objective.id, "error screen.png", PNG_BYTES))

    assert attachment.content_type == "image/png"
    assert attachment.filename == "error screen.png"
    assert attachment.size_bytes == len(PNG_BYTES)
    stored = attachment_file_path(attachment, settings)
    assert stored.read_bytes() == PNG_BYTES
    assert provider_attachment_path(attachment, settings) == (
        f"/workspaces/attachments/{attachment.objective_id}/{attachment.id}.png"
    )


def test_upload_rejects_unsupported_oversized_and_excess_files(tmp_path: Path) -> None:
    settings = _attachment_settings(tmp_path)
    objective = Objective(id=uuid.uuid4(), project_id=uuid.uuid4(), title="Fix the error")

    service = AttachmentService(_service_session(objective), settings)
    with pytest.raises(ValueError, match="PNG, JPEG, WebP, or GIF"):
        asyncio.run(service.create(objective.id, "notes.txt", b"plain text"))
    oversized = b"\x89PNG\r\n\x1a\n".ljust(MAX_ATTACHMENT_BYTES + 1, b"0")
    with pytest.raises(ValueError, match="5 MB or smaller"):
        asyncio.run(service.create(objective.id, "big.png", oversized))

    full_service = AttachmentService(
        _service_session(objective, existing_count=MAX_ATTACHMENTS_PER_OBJECTIVE), settings
    )
    with pytest.raises(ValueError, match="at most"):
        asyncio.run(full_service.create(objective.id, "extra.png", PNG_BYTES))

    missing_service = AttachmentService(_service_session(None), settings)
    with pytest.raises(LookupError, match="Objective not found"):
        asyncio.run(missing_service.create(uuid.uuid4(), "image.png", PNG_BYTES))


def test_prompts_point_agents_at_reference_images() -> None:
    objective = Objective(
        id=uuid.uuid4(), project_id=uuid.uuid4(), title="Match the mockup", description=""
    )
    from mission_control.infrastructure.database.models import Agent, Project, Task

    project = Project(id=objective.project_id, name="Demo", memory="")
    image_paths = [f"/workspaces/attachments/{objective.id}/one.png"]

    planner_prompt = _planner_prompt(objective, project, "", "", image_paths)
    assert "REFERENCE IMAGES:" in planner_prompt
    assert image_paths[0] in planner_prompt
    assert "REFERENCE IMAGES:" not in _planner_prompt(objective, project, "", "")

    agent = Agent(id=uuid.uuid4(), name="Dev", role="developer", provider="codex", instructions="")
    task = Task(id=uuid.uuid4(), objective_id=objective.id, title="Build the page")
    execution_prompt = _execution_prompt(
        objective=objective,
        project=project,
        task=task,
        agent=agent,
        coding_standards="",
        completed_tasks=[],
        image_paths=image_paths,
    )
    assert "REFERENCE IMAGES:" in execution_prompt
    assert image_paths[0] in execution_prompt
    no_image_prompt = _execution_prompt(
        objective=objective,
        project=project,
        task=task,
        agent=agent,
        coding_standards="",
        completed_tasks=[],
    )
    assert "REFERENCE IMAGES:" not in no_image_prompt


def test_deleting_an_attachment_removes_the_stored_file(tmp_path: Path) -> None:
    settings = _attachment_settings(tmp_path)
    objective = Objective(id=uuid.uuid4(), project_id=uuid.uuid4(), title="Fix the error")
    session = _service_session(objective)
    service = AttachmentService(session, settings)
    attachment = asyncio.run(service.create(objective.id, "error.png", PNG_BYTES))
    stored = attachment_file_path(attachment, settings)
    assert stored.exists()

    session.get = AsyncMock(
        side_effect=lambda model, key: attachment
        if model is ObjectiveAttachment and key == attachment.id
        else None
    )
    session.delete = AsyncMock()
    asyncio.run(service.delete(objective.id, attachment.id))
    assert not stored.exists()
