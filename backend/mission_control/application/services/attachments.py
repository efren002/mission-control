from __future__ import annotations

import asyncio
import shutil
import uuid
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.core.config import Settings, get_settings
from mission_control.infrastructure.database.models import Objective, ObjectiveAttachment

MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
MAX_ATTACHMENTS_PER_OBJECTIVE = 6

_IMAGE_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def sniff_image_type(data: bytes) -> str | None:
    """Detect a supported image type from the file signature.

    The client-declared content type is ignored: the stored type and the file
    served back to the browser both come from the actual bytes.
    """
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _stored_filename(attachment_id: uuid.UUID, content_type: str) -> str:
    return f"{attachment_id}{_IMAGE_EXTENSIONS[content_type]}"


def attachment_file_path(
    attachment: ObjectiveAttachment, settings: Settings | None = None
) -> Path:
    resolved = settings or get_settings()
    return (
        Path(resolved.attachment_root)
        / str(attachment.objective_id)
        / _stored_filename(attachment.id, attachment.content_type)
    )


def provider_attachment_path(
    attachment: ObjectiveAttachment, settings: Settings | None = None
) -> str:
    """Path of the stored file as seen from inside the provider gateway."""
    resolved = settings or get_settings()
    return str(
        Path(resolved.provider_attachment_root)
        / str(attachment.objective_id)
        / _stored_filename(attachment.id, attachment.content_type)
    )


async def list_provider_attachment_paths(
    session: AsyncSession, objective_id: uuid.UUID, settings: Settings | None = None
) -> list[str]:
    """Provider-visible file paths for an objective, oldest first."""
    attachments = await session.scalars(
        select(ObjectiveAttachment)
        .where(ObjectiveAttachment.objective_id == objective_id)
        .order_by(ObjectiveAttachment.created_at)
    )
    return [provider_attachment_path(item, settings) for item in attachments]


async def remove_objective_attachment_files(
    objective_id: uuid.UUID, settings: Settings | None = None
) -> None:
    """Best-effort removal of every stored file for an objective."""
    resolved = settings or get_settings()
    directory = Path(resolved.attachment_root) / str(objective_id)
    await asyncio.to_thread(shutil.rmtree, directory, True)


class AttachmentService:
    def __init__(self, session: AsyncSession, settings: Settings | None = None) -> None:
        self.session = session
        self.settings = settings or get_settings()

    async def list(self, objective_id: uuid.UUID) -> list[ObjectiveAttachment]:
        if await self.session.get(Objective, objective_id) is None:
            raise LookupError("Objective not found")
        result = await self.session.scalars(
            select(ObjectiveAttachment)
            .where(ObjectiveAttachment.objective_id == objective_id)
            .order_by(ObjectiveAttachment.created_at)
        )
        return list(result)

    async def create(
        self, objective_id: uuid.UUID, filename: str | None, data: bytes
    ) -> ObjectiveAttachment:
        if await self.session.get(Objective, objective_id) is None:
            raise LookupError("Objective not found")
        if not data:
            raise ValueError("The uploaded file is empty")
        if len(data) > MAX_ATTACHMENT_BYTES:
            raise ValueError("Images must be 5 MB or smaller")
        content_type = sniff_image_type(data)
        if content_type is None:
            raise ValueError("Only PNG, JPEG, WebP, or GIF images are supported")
        count = await self.session.scalar(
            select(func.count())
            .select_from(ObjectiveAttachment)
            .where(ObjectiveAttachment.objective_id == objective_id)
        )
        if (count or 0) >= MAX_ATTACHMENTS_PER_OBJECTIVE:
            raise ValueError(
                f"A mission can have at most {MAX_ATTACHMENTS_PER_OBJECTIVE} images"
            )
        display_name = Path(filename).name[:255] if filename else ""
        attachment = ObjectiveAttachment(
            objective_id=objective_id,
            filename=display_name or f"image{_IMAGE_EXTENSIONS[content_type]}",
            content_type=content_type,
            size_bytes=len(data),
        )
        self.session.add(attachment)
        await self.session.flush()
        path = attachment_file_path(attachment, self.settings)
        await asyncio.to_thread(self._write_file, path, data)
        try:
            await self.session.commit()
        except Exception:
            await asyncio.to_thread(path.unlink, True)
            raise
        await self.session.refresh(attachment)
        return attachment

    async def read_content(
        self, objective_id: uuid.UUID, attachment_id: uuid.UUID
    ) -> tuple[ObjectiveAttachment, bytes]:
        attachment = await self._get(objective_id, attachment_id)
        path = attachment_file_path(attachment, self.settings)
        try:
            data = await asyncio.to_thread(path.read_bytes)
        except FileNotFoundError as error:
            raise LookupError("The attachment file is missing from storage") from error
        return attachment, data

    async def delete(self, objective_id: uuid.UUID, attachment_id: uuid.UUID) -> None:
        attachment = await self._get(objective_id, attachment_id)
        path = attachment_file_path(attachment, self.settings)
        await self.session.delete(attachment)
        await self.session.commit()
        await asyncio.to_thread(path.unlink, True)

    async def _get(
        self, objective_id: uuid.UUID, attachment_id: uuid.UUID
    ) -> ObjectiveAttachment:
        attachment = await self.session.get(ObjectiveAttachment, attachment_id)
        if attachment is None or attachment.objective_id != objective_id:
            raise LookupError("Attachment not found")
        return attachment

    @staticmethod
    def _write_file(path: Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
