"""Record the files each task expects to touch for pre-execution overlap safety.

Revision ID: 20260720_0022
Revises: 20260720_0021
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260720_0022"
down_revision: str | None = "20260720_0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column(
            "predicted_files",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'::json"),
        ),
    )


def downgrade() -> None:
    op.drop_column("tasks", "predicted_files")
