from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from mission_control.core.config import Settings, get_settings

OnOutput = Callable[[str], Awaitable[None]]


class ProviderExecutionError(RuntimeError):
    """Raised when the provider process or gateway response is unsuccessful."""


class GatewayRequestError(ProviderExecutionError):
    """Raised when the gateway rejects a request, keeping its HTTP status."""

    def __init__(self, detail: str, status_code: int) -> None:
        super().__init__(detail)
        self.status_code = status_code


def provider_workspace(repository_path: str, settings: Settings | None = None) -> str:
    """Map a repository path from the API/worker mount to the gateway's mount."""
    resolved_settings = settings or get_settings()
    repository = Path(repository_path).resolve()
    root = Path(resolved_settings.repository_root).resolve()
    try:
        relative = repository.relative_to(root)
    except ValueError as error:
        raise ValueError("Repository is outside the configured repository root") from error
    return str(Path(resolved_settings.provider_repository_root) / relative)


@dataclass(frozen=True)
class ProviderExecution:
    stdout: str
    stderr: str
    exit_code: int | None
    timed_out: bool
    duration_ms: int | None


def parse_gateway_events(body: str) -> ProviderExecution:
    """Reconstruct a provider result from the gateway's SSE response."""
    event_name: str | None = None
    stdout: list[str] = []
    stderr: list[str] = []
    completed: dict[str, Any] | None = None

    for line in body.splitlines():
        if line.startswith("event:"):
            event_name = line.removeprefix("event:").strip()
            continue
        if not line.startswith("data:"):
            continue
        raw_data = line.removeprefix("data:").strip()
        try:
            payload = json.loads(raw_data)
        except json.JSONDecodeError as error:
            raise ProviderExecutionError("Gateway returned malformed event data") from error
        if not isinstance(payload, dict):
            raise ProviderExecutionError("Gateway event data must be an object")
        if event_name == "stdout" and isinstance(payload.get("data"), str):
            stdout.append(payload["data"])
        elif event_name == "stderr" and isinstance(payload.get("data"), str):
            stderr.append(payload["data"])
        elif event_name == "completed":
            completed = payload
        elif event_name == "error":
            detail = payload.get("detail")
            raise ProviderExecutionError(
                detail if isinstance(detail, str) else "Provider gateway execution failed"
            )
        event_name = None

    if completed is None:
        raise ProviderExecutionError("Gateway response ended without a completion event")
    exit_code = completed.get("exitCode")
    duration_ms = completed.get("durationMs")
    return ProviderExecution(
        stdout="".join(stdout),
        stderr="".join(stderr),
        exit_code=exit_code if isinstance(exit_code, int) else None,
        timed_out=completed.get("timedOut") is True,
        duration_ms=duration_ms if isinstance(duration_ms, int) else None,
    )


class ProviderGatewayClient:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    async def health(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(f"{self.settings.provider_gateway_url}/health")
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ValueError("Gateway health response must be an object")
                return {"status": "operational", **payload}
        except (httpx.HTTPError, ValueError) as error:
            return {"status": "unavailable", "detail": str(error)}

    async def providers(self) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {self.settings.provider_gateway_token}"}
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                f"{self.settings.provider_gateway_url}/v1/providers", headers=headers
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError("Gateway providers response must be an object")
            return payload

    async def login_start(self, provider: str) -> tuple[int, dict[str, Any]]:
        return await self._login_request("POST", f"/v1/providers/{provider}/login", None)

    async def login_status(self, provider: str) -> tuple[int, dict[str, Any]]:
        return await self._login_request("GET", f"/v1/providers/{provider}/login", None)

    async def login_submit_code(self, provider: str, code: str) -> tuple[int, dict[str, Any]]:
        return await self._login_request(
            "POST", f"/v1/providers/{provider}/login/input", {"code": code}
        )

    async def login_cancel(self, provider: str) -> tuple[int, dict[str, Any]]:
        return await self._login_request("DELETE", f"/v1/providers/{provider}/login", None)

    async def _login_request(
        self, method: str, path: str, body: dict[str, Any] | None
    ) -> tuple[int, dict[str, Any]]:
        """Forward a login request, preserving the gateway's status code.

        Login responses use 400/404/409 to describe session state, so callers
        need the status alongside the payload instead of a raised error.
        """
        headers = {"Authorization": f"Bearer {self.settings.provider_gateway_token}"}
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.request(
                method,
                f"{self.settings.provider_gateway_url}{path}",
                headers=headers,
                json=body,
            )
            try:
                payload = response.json()
            except ValueError as error:
                raise ProviderExecutionError("Gateway login response must be JSON") from error
            if not isinstance(payload, dict):
                raise ProviderExecutionError("Gateway login response must be an object")
            return response.status_code, payload

    async def git_checkpoint(self, workspace: str, message: str) -> str | None:
        """Commit every pending change in the workspace as a checkpoint.

        Returns the commit SHA, or None when the working tree was clean.
        """
        headers = {"Authorization": f"Bearer {self.settings.provider_gateway_token}"}
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{self.settings.provider_gateway_url}/v1/git/checkpoint",
                headers=headers,
                json={"workspace": workspace, "message": message},
            )
            if response.status_code != 200:
                detail: object = None
                try:
                    detail = response.json().get("detail")
                except ValueError:
                    detail = None
                raise ProviderExecutionError(
                    detail
                    if isinstance(detail, str)
                    else f"Checkpoint failed with status {response.status_code}"
                )
            payload = response.json()
            sha = payload.get("commitSha") if isinstance(payload, dict) else None
            return sha if isinstance(sha, str) and sha else None

    async def git_revert(self, workspace: str, commit_sha: str) -> str:
        """Revert one checkpoint commit and return the new revert commit SHA."""
        headers = {"Authorization": f"Bearer {self.settings.provider_gateway_token}"}
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{self.settings.provider_gateway_url}/v1/git/revert",
                headers=headers,
                json={"workspace": workspace, "commitSha": commit_sha},
            )
            if response.status_code != 200:
                detail: object = None
                try:
                    detail = response.json().get("detail")
                except ValueError:
                    detail = None
                raise ProviderExecutionError(
                    detail
                    if isinstance(detail, str)
                    else f"Revert failed with status {response.status_code}"
                )
            payload = response.json()
            revert_sha = payload.get("revertSha") if isinstance(payload, dict) else None
            if not isinstance(revert_sha, str) or not revert_sha:
                raise ProviderExecutionError("Gateway revert response is missing the commit")
            return revert_sha

    async def run_command(
        self,
        workspace: str,
        command: str,
        timeout_seconds: int = 900,
        on_output: OnOutput | None = None,
    ) -> ProviderExecution:
        """Run a project command through the gateway, streaming the SSE response.

        A nonzero exit code is a result, not an error: callers decide what a
        failing command means. When on_output is provided it receives the
        rolling tail of combined stdout and stderr while the command runs.
        """
        headers = {"Authorization": f"Bearer {self.settings.provider_gateway_token}"}
        stdout: list[str] = []
        stderr: list[str] = []
        completed: dict[str, Any] | None = None
        event_name: str | None = None
        tail = ""
        buffer = ""
        async with httpx.AsyncClient(timeout=float(timeout_seconds + 10)) as client:
            async with client.stream(
                "POST",
                f"{self.settings.provider_gateway_url}/v1/commands/stream",
                headers=headers,
                json={
                    "workspace": workspace,
                    "command": command,
                    "timeoutMs": timeout_seconds * 1000,
                },
            ) as response:
                if response.status_code != 200:
                    await response.aread()
                    detail: object = None
                    try:
                        detail = response.json().get("detail")
                    except ValueError:
                        detail = None
                    raise GatewayRequestError(
                        detail
                        if isinstance(detail, str)
                        else f"Command failed with status {response.status_code}",
                        response.status_code,
                    )
                async for chunk in response.aiter_text():
                    buffer += chunk
                    lines = buffer.split("\n")
                    buffer = lines.pop()
                    for line in lines:
                        if line.startswith("event:"):
                            event_name = line.removeprefix("event:").strip()
                            continue
                        if not line.startswith("data:"):
                            continue
                        raw_data = line.removeprefix("data:").strip()
                        try:
                            payload = json.loads(raw_data)
                        except json.JSONDecodeError as error:
                            raise ProviderExecutionError(
                                "Gateway returned malformed event data"
                            ) from error
                        if not isinstance(payload, dict):
                            raise ProviderExecutionError("Gateway event data must be an object")
                        if (
                            event_name in ("stdout", "stderr")
                            and isinstance(payload.get("data"), str)
                        ):
                            (stdout if event_name == "stdout" else stderr).append(payload["data"])
                            if on_output is not None:
                                tail = f"{tail}{payload['data']}"[-4000:]
                                await on_output(tail)
                        elif event_name == "completed":
                            completed = payload
                        elif event_name == "error":
                            error_detail = payload.get("detail")
                            raise ProviderExecutionError(
                                error_detail
                                if isinstance(error_detail, str)
                                else "Gateway command execution failed"
                            )
                        event_name = None

        if completed is None:
            raise ProviderExecutionError("Gateway response ended without a completion event")
        exit_code = completed.get("exitCode")
        duration_ms = completed.get("durationMs")
        return ProviderExecution(
            stdout="".join(stdout),
            stderr="".join(stderr),
            exit_code=exit_code if isinstance(exit_code, int) else None,
            timed_out=completed.get("timedOut") is True,
            duration_ms=duration_ms if isinstance(duration_ms, int) else None,
        )

    async def app_start(self, workspace: str, command: str) -> dict[str, Any]:
        return await self._app_request(
            "POST", "/v1/apps/start", {"workspace": workspace, "command": command}
        )

    async def app_stop(self, workspace: str) -> dict[str, Any]:
        return await self._app_request("POST", "/v1/apps/stop", {"workspace": workspace})

    async def app_list(self) -> list[dict[str, Any]]:
        payload = await self._app_request("GET", "/v1/apps", None)
        apps = payload.get("apps")
        return [app for app in apps if isinstance(app, dict)] if isinstance(apps, list) else []

    async def _app_request(
        self, method: str, path: str, body: dict[str, Any] | None
    ) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {self.settings.provider_gateway_token}"}
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.request(
                method,
                f"{self.settings.provider_gateway_url}{path}",
                headers=headers,
                json=body,
            )
            if response.status_code != 200:
                detail: object = None
                try:
                    detail = response.json().get("detail")
                except ValueError:
                    detail = None
                raise GatewayRequestError(
                    detail
                    if isinstance(detail, str)
                    else f"Gateway request failed with status {response.status_code}",
                    response.status_code,
                )
            payload = response.json()
            if not isinstance(payload, dict):
                raise ProviderExecutionError("Gateway response must be an object")
            return payload

    async def execute(
        self,
        provider: str,
        prompt: str,
        workspace: str = "/workspaces",
        model: str | None = None,
        timeout_seconds: int = 1800,
        access_mode: str = "read-only",
        usage_label: str | None = None,
        on_output: OnOutput | None = None,
    ) -> str:
        """Run a provider through the gateway, streaming the SSE response.

        When on_output is provided it receives the rolling tail of provider
        stdout while the process runs, so callers can surface live progress.
        """
        headers = {"Authorization": f"Bearer {self.settings.provider_gateway_token}"}
        stdout: list[str] = []
        stderr: list[str] = []
        completed: dict[str, Any] | None = None
        event_name: str | None = None
        tail = ""
        buffer = ""
        async with httpx.AsyncClient(timeout=float(timeout_seconds + 10)) as client:
            async with client.stream(
                "POST",
                f"{self.settings.provider_gateway_url}/v1/execute",
                headers=headers,
                json={
                    "provider": provider,
                    "prompt": prompt,
                    "workspace": workspace,
                    "model": model,
                    "timeoutMs": timeout_seconds * 1000,
                    "accessMode": access_mode,
                    "usageLabel": usage_label,
                },
            ) as response:
                response.raise_for_status()
                async for chunk in response.aiter_text():
                    buffer += chunk
                    lines = buffer.split("\n")
                    buffer = lines.pop()
                    for line in lines:
                        if line.startswith("event:"):
                            event_name = line.removeprefix("event:").strip()
                            continue
                        if not line.startswith("data:"):
                            continue
                        raw_data = line.removeprefix("data:").strip()
                        try:
                            payload = json.loads(raw_data)
                        except json.JSONDecodeError as error:
                            raise ProviderExecutionError(
                                "Gateway returned malformed event data"
                            ) from error
                        if not isinstance(payload, dict):
                            raise ProviderExecutionError("Gateway event data must be an object")
                        if event_name == "stdout" and isinstance(payload.get("data"), str):
                            stdout.append(payload["data"])
                            if on_output is not None:
                                tail = f"{tail}{payload['data']}"[-4000:]
                                await on_output(tail)
                        elif event_name == "stderr" and isinstance(payload.get("data"), str):
                            stderr.append(payload["data"])
                        elif event_name == "completed":
                            completed = payload
                        elif event_name == "error":
                            detail = payload.get("detail")
                            raise ProviderExecutionError(
                                detail
                                if isinstance(detail, str)
                                else "Provider gateway execution failed"
                            )
                        event_name = None

        if completed is None:
            raise ProviderExecutionError("Gateway response ended without a completion event")
        if completed.get("timedOut") is True:
            raise ProviderExecutionError("Provider execution timed out")
        exit_code = completed.get("exitCode")
        if exit_code != 0:
            # Claude reports failures (max turns, refusals) in the final JSON
            # result on stdout with nothing on stderr, so fall back to the
            # stdout tail to keep the persisted error actionable.
            detail = "".join(stderr).strip()[-2000:] or "".join(stdout).strip()[-2000:]
            raise ProviderExecutionError(
                f"Provider exited with code {exit_code}" + (f": {detail}" if detail else "")
            )
        return "".join(stdout)
