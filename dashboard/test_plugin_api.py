from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
import tempfile
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("plugin_api.py")
SPEC = importlib.util.spec_from_file_location("connections_plugin_api", MODULE_PATH)
assert SPEC and SPEC.loader
api = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(api)


class ServiceHealthTests(unittest.TestCase):
    def setUp(self):
        home = tempfile.TemporaryDirectory(prefix="connections-test-")
        self.addCleanup(home.cleanup)
        self.home = Path(home.name)
        for guard in (
            patch.object(api, "_hermes_home", return_value=self.home),
            patch.object(api.Path, "home", return_value=self.home),
            patch.dict(api.os.environ, {"HOME": home.name, "HERMES_HOME": home.name}, clear=True),
            patch.object(api.subprocess, "run", side_effect=AssertionError("Live subprocess forbidden")),
            patch.object(api.urllib.request, "urlopen", side_effect=AssertionError("Live HTTP forbidden")),
        ):
            guard.start()
            self.addCleanup(guard.stop)

    def test_ticktick_token_reads_only_isolated_profile(self):
        directory = self.home / "ticktick"
        directory.mkdir()
        token = directory / "token.json"
        token.write_text('{"access_token":"fixture-only"}')
        self.assertEqual(api._ticktick_token(), "fixture-only")
        for malformed in ("[]", "{broken", '{"access_token":42}'):
            token.write_text(malformed)
            self.assertIsNone(api._ticktick_token())

    def assert_health_contract(self, result, *, reason):
        self.assertEqual(result["reason"], reason)
        self.assertEqual(result["source"], "connections-local")
        self.assertIn(result["repair"], {
            "none", "hevy_auth", "ticktick_auth", "github_auth",
            "github_install", "apple_permission", "apple_install", "retry",
            "inspect_plugin_logs",
        })
        self.assertIsInstance(result["checked_at"], int)
        self.assertGreater(result["checked_at"], 0)

    @patch.object(api, "_http_status", return_value=200)
    @patch.object(api, "_keychain_secret", return_value="secret")
    def test_hevy_connected_without_exposing_secret(self, _keychain, _http):
        result = api._check_hevy()
        self.assertEqual(result["status"], "connected")
        self.assert_health_contract(result, reason="healthy")
        self.assertNotIn("secret", str(result))

    @patch.object(api, "_http_status", return_value=401)
    @patch.object(api, "_ticktick_token", return_value="token")
    def test_ticktick_auth_failure(self, _token, _http):
        result = api._check_ticktick()
        self.assertEqual(result["status"], "auth_error")
        self.assert_health_contract(result, reason="auth_required")

    @patch.object(api, "_keychain_secret", return_value=None)
    def test_missing_hevy_key_is_neutral(self, _keychain):
        result = api._check_hevy()
        self.assertEqual(result["status"], "unconfigured")
        self.assert_health_contract(result, reason="not_configured")

    @patch.object(api, "_http_status", return_value=None)
    @patch.object(api, "_keychain_secret", return_value="secret")
    def test_hevy_network_failure_is_unreachable(self, _keychain, _http):
        result = api._check_hevy()
        self.assertEqual(result["status"], "unavailable")
        self.assert_health_contract(result, reason="service_unreachable")

    @patch.object(api, "_http_status", return_value=500)
    @patch.object(api, "_keychain_secret", return_value="secret")
    def test_hevy_unexpected_response_is_check_failure(self, _keychain, _http):
        result = api._check_hevy()
        self.assertEqual(result["status"], "unavailable")
        self.assert_health_contract(result, reason="check_failed")

    @patch.object(api, "_github_cli", return_value=None)
    def test_missing_github_cli_is_not_installed(self, _github_cli):
        result = api._check_github()
        self.assertEqual(result["status"], "unconfigured")
        self.assert_health_contract(result, reason="not_installed")

    @patch.object(api, "_github_cli", return_value="/opt/homebrew/bin/gh")
    @patch.object(api.subprocess, "run")
    def test_github_connected_without_exposing_cli_output(self, run, _github_cli):
        run.return_value = SimpleNamespace(
            returncode=0,
            stdout="sensitive output must remain internal",
            stderr="",
        )

        result = api._check_github()

        self.assertEqual(result["status"], "connected")
        self.assertEqual(result["detail"], "API connected")
        self.assert_health_contract(result, reason="healthy")
        self.assertNotIn("sensitive", str(result))

    @patch.object(api.sys, "platform", "darwin")
    @patch.object(api.Path, "is_file", return_value=True)
    @patch.object(api.subprocess, "run")
    def test_apple_calendar_permission_failure_is_explicit(self, run, _is_file):
        run.return_value = SimpleNamespace(
            returncode=1,
            stdout="",
            stderr="Not authorized to send Apple events. (-1743)",
        )

        result = api._check_apple_calendar()

        self.assertEqual(result["status"], "auth_error")
        self.assert_health_contract(result, reason="permission_required")

    @patch.object(api.sys, "platform", "darwin")
    @patch.object(api.Path, "is_file", return_value=True)
    @patch.object(api.subprocess, "run")
    def test_apple_calendar_connected_without_exposing_calendar_names(
        self, run, _is_file
    ):
        run.return_value = SimpleNamespace(
            returncode=0,
            stdout='[{"name":"Privat"},{"name":"Arbeit"}]',
            stderr="",
        )

        result = api._check_apple_calendar()

        self.assertEqual(result["status"], "connected")
        self.assertEqual(result["detail"], "calendar connected")
        self.assert_health_contract(result, reason="healthy")
        self.assertNotIn("Privat", str(result))

    @patch.object(api, "_check_apple_calendar")
    @patch.object(api, "_check_github")
    @patch.object(api, "_check_ticktick")
    @patch.object(api, "_check_hevy")
    def test_services_omit_unregistered_optional_checks(
        self, hevy, ticktick, github, apple_calendar
    ):
        hevy.return_value = api._result("hevy", "Hevy", "unconfigured", "not configured", "not_configured")
        ticktick.return_value = api._result("ticktick", "TickTick", "connected", "API connected", "healthy")
        github.return_value = api._result("github", "GitHub", "unconfigured", "CLI not installed", "not_installed")
        apple_calendar.return_value = api._result("apple-calendar", "Apple Calendar", "auth_error", "permission required", "permission_required")

        result = asyncio.run(api.services())

        self.assertEqual([item["id"] for item in result["services"]], ["ticktick", "apple-calendar"])


if __name__ == "__main__":
    unittest.main()
