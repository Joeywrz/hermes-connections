"""Credential-safe health checks for external Connections services."""

from __future__ import annotations

import asyncio
import getpass
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

from fastapi import APIRouter

router = APIRouter()


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return get_hermes_home()
    except Exception:
        configured = os.environ.get("HERMES_HOME", "").strip()
        return Path(configured).expanduser() if configured else Path.home() / ".hermes"


def _keychain_secret(service: str) -> str | None:
    try:
        result = subprocess.run(
            [
                "security",
                "find-generic-password",
                "-a",
                os.environ.get("USER") or getpass.getuser(),
                "-s",
                service,
                "-w",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    value = result.stdout.strip() if result.returncode == 0 else ""
    return value or None


def _ticktick_token() -> str | None:
    path = _hermes_home() / "ticktick" / "token.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    token = value.get("access_token") if isinstance(value, dict) else None
    return token if isinstance(token, str) and token else None


def _http_status(url: str, headers: dict[str, str]) -> int | None:
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return int(response.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


def _result(
    service_id: str,
    name: str,
    status: str,
    detail: str,
    reason: str,
) -> dict[str, str | int]:
    repair = {
        ("hevy", "auth_required"): "hevy_auth",
        ("ticktick", "auth_required"): "ticktick_auth",
        ("github", "auth_required"): "github_auth",
        ("github", "not_installed"): "github_install",
        ("apple-calendar", "permission_required"): "apple_permission",
        ("apple-calendar", "not_installed"): "apple_install",
        (service_id, "service_unreachable"): "retry",
        (service_id, "check_failed"): "inspect_plugin_logs",
    }.get((service_id, reason), "none")
    return {
        "id": service_id,
        "name": name,
        "source": "connections-local",
        "icon": service_id,
        "status": status,
        "detail": detail,
        "reason": reason,
        "repair": repair,
        "checked_at": int(time.time() * 1000),
    }


def _check_hevy() -> dict[str, str | int]:
    key = _keychain_secret("hevy-api")
    if not key:
        return _result("hevy", "Hevy", "unconfigured", "not configured", "not_configured")
    status = _http_status(
        "https://api.hevyapp.com/v1/user/info",
        {"api-key": key, "Accept": "application/json", "User-Agent": "Hermes-Connections/1.0"},
    )
    if status is not None and 200 <= status < 300:
        return _result("hevy", "Hevy", "connected", "API connected", "healthy")
    if status in {401, 403}:
        return _result("hevy", "Hevy", "auth_error", "login required", "auth_required")
    if status is None:
        return _result("hevy", "Hevy", "unavailable", "API unavailable", "service_unreachable")
    return _result("hevy", "Hevy", "unavailable", "health check failed", "check_failed")


def _check_ticktick() -> dict[str, str | int]:
    token = _ticktick_token()
    if not token:
        return _result("ticktick", "TickTick", "unconfigured", "not configured", "not_configured")
    status = _http_status(
        "https://api.ticktick.com/open/v1/project",
        {"Authorization": f"Bearer {token}", "Accept": "application/json", "User-Agent": "Hermes-Connections/1.0"},
    )
    if status is not None and 200 <= status < 300:
        return _result("ticktick", "TickTick", "connected", "API connected", "healthy")
    if status in {401, 403}:
        return _result("ticktick", "TickTick", "auth_error", "login required", "auth_required")
    if status is None:
        return _result("ticktick", "TickTick", "unavailable", "API unavailable", "service_unreachable")
    return _result("ticktick", "TickTick", "unavailable", "health check failed", "check_failed")


def _github_cli() -> str | None:
    candidates = (shutil.which("gh"), "/opt/homebrew/bin/gh", "/usr/local/bin/gh")
    return next(
        (candidate for candidate in candidates if candidate and Path(candidate).is_file()),
        None,
    )


def _check_github() -> dict[str, str | int]:
    executable = _github_cli()
    if not executable:
        return _result("github", "GitHub", "unconfigured", "CLI not installed", "not_installed")
    try:
        completed = subprocess.run(
            [executable, "api", "user", "--silent"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return _result("github", "GitHub", "unavailable", "API unavailable", "service_unreachable")
    if completed.returncode == 0:
        return _result("github", "GitHub", "connected", "API connected", "healthy")
    error = (completed.stderr or "").casefold()
    if any(marker in error for marker in ("authentication", "not logged", "401", "token")):
        return _result("github", "GitHub", "auth_error", "login required", "auth_required")
    return _result("github", "GitHub", "unavailable", "health check failed", "check_failed")


def _check_apple_calendar() -> dict[str, str | int]:
    script = (
        _hermes_home()
        / "plugins"
        / "apple_calendar"
        / "scripts"
        / "list_calendars.js"
    )
    if sys.platform != "darwin" or not script.is_file():
        return _result("apple-calendar", "Apple Calendar", "unconfigured", "plugin not installed", "not_installed")
    try:
        completed = subprocess.run(
            ["/usr/bin/osascript", "-l", "JavaScript", str(script)],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return _result("apple-calendar", "Apple Calendar", "unavailable", "calendar unavailable", "service_unreachable")
    if completed.returncode != 0:
        error = (completed.stderr or "").casefold()
        if "not authorized" in error or "-1743" in error or "permission" in error:
            return _result("apple-calendar", "Apple Calendar", "auth_error", "permission required", "permission_required")
        return _result("apple-calendar", "Apple Calendar", "unavailable", "health check failed", "check_failed")
    try:
        calendars = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return _result("apple-calendar", "Apple Calendar", "unavailable", "health check failed", "check_failed")
    if not isinstance(calendars, list):
        return _result("apple-calendar", "Apple Calendar", "unavailable", "health check failed", "check_failed")
    return _result("apple-calendar", "Apple Calendar", "connected", "calendar connected", "healthy")


@router.get("/services")
async def services() -> dict[str, list[dict[str, str | int]]]:
    hevy, ticktick, github, apple_calendar = await asyncio.gather(
        asyncio.to_thread(_check_hevy),
        asyncio.to_thread(_check_ticktick),
        asyncio.to_thread(_check_github),
        asyncio.to_thread(_check_apple_calendar),
    )
    # This endpoint contributes only services that already have a local
    # registration signal (credential, CLI, or plugin). Connections is an
    # operational view, not a second catalogue of things the user could install.
    discovered = [hevy, ticktick, github, apple_calendar]
    return {
        "services": [
            item
            for item in discovered
            if item["reason"] not in {"not_configured", "not_installed"}
        ]
    }
