"""Run with: python -m unittest discover -s skills/bbtodo/tests"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib import error

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import bbtodo  # noqa: E402

REAL_PARSE_ENV_FILE = bbtodo.parse_env_file


class BaseUrlTests(unittest.TestCase):
    def setUp(self) -> None:
        state_root = tempfile.TemporaryDirectory()
        self.addCleanup(state_root.cleanup)

        env = {key: value for key, value in os.environ.items() if not key.startswith("BBTODO_")}
        env["BBTODO_API_TOKEN"] = "token-under-test"
        env["BBTODO_STATE_ROOT"] = state_root.name
        self.start_patch(mock.patch.dict(os.environ, env, clear=True))

        # Ignore any real scripts/.env and make sure no request can leave this machine.
        self.parse_env_file = self.start_patch(mock.patch.object(bbtodo, "parse_env_file", return_value={}))
        self.urlopen = self.start_patch(
            mock.patch.object(bbtodo.request, "urlopen", side_effect=error.URLError("offline"))
        )

    def start_patch(self, patcher):
        started = patcher.start()
        self.addCleanup(patcher.stop)
        return started

    def run_cli(self, *argv: str) -> str:
        args = bbtodo.build_parser().parse_args(list(argv))
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            args.func(args)
        return stdout.getvalue()

    def assert_requests_only_go_to(self, base_url: str) -> None:
        self.urlopen.assert_called()
        for call in self.urlopen.call_args_list:
            self.assertTrue(call.args[0].full_url.startswith(f"{base_url}/api/v1/"), call.args[0].full_url)

    def test_start_without_a_base_url_fails_before_sending_anything(self) -> None:
        with self.assertRaisesRegex(bbtodo.BBTodoError, "BBTODO_BASE_URL"):
            self.run_cli("start", "--title", "Some work")

        self.urlopen.assert_not_called()

    def test_start_uses_the_base_url_from_the_environment(self) -> None:
        os.environ["BBTODO_BASE_URL"] = "https://bbtodo.internal.example/"

        with self.assertRaises(bbtodo.BBTodoError):
            self.run_cli("start", "--title", "Some work")

        self.assert_requests_only_go_to("https://bbtodo.internal.example")

    def test_start_uses_the_base_url_from_the_flag(self) -> None:
        with self.assertRaises(bbtodo.BBTodoError):
            self.run_cli("--base-url", "https://flag.example", "start", "--title", "Some work")

        self.assert_requests_only_go_to("https://flag.example")

    def test_copied_env_example_cannot_send_the_token_anywhere(self) -> None:
        self.parse_env_file.return_value = REAL_PARSE_ENV_FILE(SCRIPTS_DIR / ".env.example")

        with self.assertRaisesRegex(bbtodo.BBTodoError, "must start with http"):
            self.run_cli("start", "--title", "Some work")

        self.urlopen.assert_not_called()

    def test_recovery_commands_work_without_a_base_url(self) -> None:
        self.run_cli("status")
        self.run_cli("clear-state")

        token_status = json.loads(self.run_cli("token-status"))

        self.assertEqual(token_status["baseUrl"], "")
        self.assertIn("BBTODO_BASE_URL", token_status["message"])
        self.urlopen.assert_not_called()

    def test_token_status_has_no_message_when_fully_configured(self) -> None:
        os.environ["BBTODO_BASE_URL"] = "https://bbtodo.internal.example"

        token_status = json.loads(self.run_cli("token-status"))

        self.assertEqual(token_status["baseUrl"], "https://bbtodo.internal.example")
        self.assertNotIn("message", token_status)

    def test_tracked_task_keeps_using_the_recorded_base_url(self) -> None:
        args = bbtodo.build_parser().parse_args(["begin-work"])
        state_file = bbtodo.build_config(args).state_file
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(
            json.dumps(
                {
                    "baseUrl": "https://recorded.example",
                    "project": {"id": "project-1", "name": "Project", "url": ""},
                    "task": {"id": "task-1", "title": "Some work"},
                }
            ),
            encoding="utf-8",
        )

        with self.assertRaises(bbtodo.BBTodoError):
            self.run_cli("begin-work")

        self.assert_requests_only_go_to("https://recorded.example")


if __name__ == "__main__":
    unittest.main()
