#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, request


class BBTodoError(RuntimeError):
    pass


@dataclass
class ScriptConfig:
    active_lane: str
    api_token: str
    api_token_source: str
    base_url: str
    env_file: Path
    project_name: str
    review_lane: str
    start_lane: str
    state_file: Path
    worktree: str


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalize_base_url(base_url: str) -> str:
    normalized = base_url.strip().rstrip("/")
    if not normalized.startswith(("http://", "https://")):
        raise BBTodoError("BBTODO_BASE_URL must start with http:// or https://.")
    return normalized


def resolve_worktree(worktree: str | None) -> str:
    return str(Path(worktree or os.getcwd()).resolve())


def default_project_name(worktree: str) -> str:
    name = Path(worktree).name.strip()
    return name or "bbtodo"


def parse_env_file(env_file: Path) -> dict[str, str]:
    if not env_file.exists():
        return {}

    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(env_file.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise BBTodoError(f"Malformed env line in {env_file}:{line_number}. Expected KEY=value.")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            raise BBTodoError(f"Malformed env line in {env_file}:{line_number}. Empty key.")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        values[key] = value
    return values


def resolve_config_value(
    cli_value: str | None,
    env_name: str,
    env_file_values: dict[str, str],
    default: str = "",
) -> str:
    if cli_value is not None and cli_value.strip():
        return cli_value.strip()

    process_value = os.getenv(env_name, "").strip()
    if process_value:
        return process_value

    file_value = env_file_values.get(env_name, "").strip()
    if file_value:
        return file_value

    return default


def resolve_api_token(cli_value: str | None, env_file_values: dict[str, str]) -> tuple[str, str]:
    if cli_value is not None and cli_value.strip():
        return cli_value.strip(), "cli"

    process_value = os.getenv("BBTODO_API_TOKEN", "").strip()
    if process_value:
        return process_value, "env"

    file_value = env_file_values.get("BBTODO_API_TOKEN", "").strip()
    if file_value:
        return file_value, "env-file"

    return "", "missing"


def expand_config_path(raw_path: str, *, base_dir: Path | None = None) -> Path:
    expanded = Path(raw_path).expanduser()
    if expanded.is_absolute():
        return expanded
    if base_dir is not None:
        return (base_dir / expanded).resolve()
    return expanded.resolve()


def resolve_state_file(worktree: str, explicit_state_key: str | None, state_root: Path) -> Path:
    state_key = explicit_state_key or hashlib.sha1(worktree.encode("utf-8")).hexdigest()[:12]
    return state_root / f"{state_key}.json"


def load_state(state_file: Path) -> dict[str, Any] | None:
    if not state_file.exists():
        return None
    try:
        payload = json.loads(state_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise BBTodoError(f"State file {state_file} is malformed. Run clear-state to reset it.") from exc
    if not isinstance(payload, dict):
        raise BBTodoError(f"State file {state_file} is malformed. Run clear-state to reset it.")
    return payload


def save_state(state_file: Path, payload: dict[str, Any]) -> None:
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def delete_state(state_file: Path) -> None:
    if state_file.exists():
        state_file.unlink()


def read_text_argument(raw_value: str | None, file_path: str | None) -> str:
    if raw_value and file_path:
        raise BBTodoError("Choose either the inline text argument or the file argument, not both.")
    if file_path:
        return Path(file_path).read_text(encoding="utf-8").strip()
    return (raw_value or "").strip()


def join_markdown_sections(*sections: str) -> str:
    return "\n\n".join(section.rstrip() for section in sections if section and section.strip())


def build_tracking_section(worktree: str) -> str:
    return "\n".join(
        [
            "## Tracking",
            f"- Worktree: `{worktree}`",
            f"- Started: {utc_now()}",
        ]
    )


def build_start_body(body: str, worktree: str) -> str:
    return join_markdown_sections(body, build_tracking_section(worktree))


def build_attached_start_body(existing_body: str, body: str, worktree: str) -> str:
    return join_markdown_sections(existing_body, body, build_tracking_section(worktree))


def detect_git_branch(worktree: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True,
            cwd=worktree,
            check=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None

    branch = result.stdout.strip()
    return branch or None


def build_finish_body(existing_body: str, note: str, branch_name: str | None) -> str:
    handoff_lines = ["## Review Handoff", f"- Ready for review: {utc_now()}"]
    if branch_name:
        handoff_lines.append(f"- Branch: `{branch_name}`")
    if note:
        handoff_lines.append(note.rstrip())
    handoff = "\n".join(handoff_lines)
    if not existing_body.strip():
        return handoff
    return f"{existing_body.rstrip()}\n\n{handoff}"


def build_resume_body(existing_body: str, details: str) -> str:
    follow_up_lines = ["## Follow-Up", f"- Resumed: {utc_now()}"]
    if details:
        follow_up_lines.append(details.rstrip())
    follow_up = "\n".join(follow_up_lines)
    if not existing_body.strip():
        return follow_up
    return f"{existing_body.rstrip()}\n\n{follow_up}"


def titles_match(first: str, second: str) -> bool:
    return first.strip().casefold() == second.strip().casefold()


def extract_ticket_id(task: dict[str, Any], fallback: Any = None) -> str | None:
    ticket_id = str(task.get("ticketId") or "").strip()
    if ticket_id:
        return ticket_id
    fallback_ticket_id = str(fallback or "").strip()
    return fallback_ticket_id or None


def update_state_task_metadata(state: dict[str, Any], task: dict[str, Any]) -> str | None:
    existing_task = state.get("task", {}) if isinstance(state.get("task"), dict) else {}
    ticket_id = extract_ticket_id(task, existing_task.get("ticketId"))
    state["task"] = {
        "id": str(task.get("id") or existing_task.get("id") or "").strip(),
        "title": str(task.get("title") or existing_task.get("title") or "").strip(),
    }
    if ticket_id:
        state["task"]["ticketId"] = ticket_id
    return ticket_id


class BBTodoClient:
    def __init__(self, base_url: str, api_token: str):
        self.base_url = normalize_base_url(base_url)
        self.api_token = api_token.strip()

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.api_token}",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"

        http_request = request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )

        try:
            with request.urlopen(http_request, timeout=30) as response:
                raw_body = response.read().decode("utf-8")
        except error.HTTPError as exc:
            raw_body = exc.read().decode("utf-8", errors="replace")
            message = raw_body
            try:
                parsed = json.loads(raw_body)
                if isinstance(parsed, dict) and isinstance(parsed.get("message"), str):
                    message = parsed["message"]
            except json.JSONDecodeError:
                pass
            raise BBTodoError(f"BBTodo API {exc.code}: {message}") from exc
        except error.URLError as exc:
            raise BBTodoError(f"Could not reach BBTodo at {self.base_url}: {exc.reason}") from exc

        if not raw_body:
            return None
        return json.loads(raw_body)

    def list_projects(self) -> list[dict[str, Any]]:
        return self._request("GET", "/api/v1/projects")

    def create_project(self, name: str) -> dict[str, Any]:
        return self._request("POST", "/api/v1/projects", {"name": name})

    def list_lanes(self, project_id: str) -> list[dict[str, Any]]:
        return self._request("GET", f"/api/v1/projects/{project_id}/lanes")

    def list_tasks(self, project_id: str) -> list[dict[str, Any]]:
        return self._request("GET", f"/api/v1/projects/{project_id}/tasks")

    def get_task_by_ticket_id(self, ticket_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/v1/tasks/by-ticket/{ticket_id}")

    def create_task(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", f"/api/v1/projects/{project_id}/tasks", payload)

    def update_task(self, project_id: str, task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("PATCH", f"/api/v1/projects/{project_id}/tasks/{task_id}", payload)


def find_by_name(items: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    desired = name.casefold()
    for item in items:
        item_name = str(item.get("name") or item.get("title") or "").strip()
        if item_name.casefold() == desired:
            return item
    return None


def get_or_create_project(client: BBTodoClient, project_name: str) -> tuple[dict[str, Any], bool]:
    projects = client.list_projects()
    existing = find_by_name(projects, project_name)
    if existing:
        return existing, False
    return client.create_project(project_name), True


def get_project_by_id(client: BBTodoClient, project_id: str) -> dict[str, Any]:
    projects = client.list_projects()
    for project in projects:
        if str(project.get("id") or "").strip() == project_id:
            return project
    raise BBTodoError(f"Project not found for task project id {project_id}.")


def get_lane(lanes: list[dict[str, Any]], lane_name: str) -> dict[str, Any]:
    lane = find_by_name(lanes, lane_name)
    if lane:
        return lane
    available = ", ".join(str(item.get("name", "")).strip() for item in lanes) or "<none>"
    raise BBTodoError(f"Lane '{lane_name}' not found. Available lanes: {available}.")


def get_task(client: BBTodoClient, project_id: str, task_id: str) -> dict[str, Any]:
    tasks = client.list_tasks(project_id)
    for task in tasks:
        if task.get("id") == task_id:
            return task
    raise BBTodoError("The tracked BBTodo task no longer exists. Run clear-state or start again.")


def is_task_in_review(
    client: BBTodoClient,
    project_id: str,
    review_lane: dict[str, Any],
    state: dict[str, Any],
) -> bool:
    current_lane_id = str(state.get("currentLane", {}).get("id") or "").strip()
    if current_lane_id:
        return current_lane_id == str(review_lane["id"])

    task_id = str(state.get("task", {}).get("id") or "").strip()
    if not task_id:
        return False

    try:
        task = get_task(client, project_id, task_id)
    except BBTodoError:
        return False

    return str(task.get("laneId") or "") == str(review_lane["id"])


def require_api_token(config: ScriptConfig) -> None:
    if config.api_token:
        return
    raise BBTodoError(
        "Missing BBTodo API token. Add BBTODO_API_TOKEN to "
        f"{config.env_file}, export it in the current shell, or pass --api-token."
    )


def require_base_url(config: ScriptConfig) -> None:
    if config.base_url:
        return
    raise BBTodoError(
        "Missing BBTodo base URL. Add BBTODO_BASE_URL to "
        f"{config.env_file}, export it in the current shell, or pass --base-url."
    )


def require_tracked_task_context(state: dict[str, Any], state_file: Path) -> tuple[str, str, str, str]:
    project = state.get("project")
    task = state.get("task")
    if not isinstance(project, dict) or not isinstance(task, dict):
        raise BBTodoError(f"State file {state_file} is incomplete. Run clear-state or start again.")

    project_id = str(project.get("id") or "").strip()
    task_id = str(task.get("id") or "").strip()
    project_name = str(project.get("name") or "").strip()
    project_url = str(project.get("url") or "").strip()

    if not project_id or not task_id:
        raise BBTodoError(f"State file {state_file} is incomplete. Run clear-state or start again.")

    return project_id, task_id, project_name, project_url


def build_config(args: argparse.Namespace) -> ScriptConfig:
    env_file = Path(__file__).resolve().parent / ".env"
    env_file_values = parse_env_file(env_file)
    worktree = resolve_worktree(args.worktree)

    # No default: a forgotten setting must not send the API token to a host the user didn't choose.
    raw_base_url = resolve_config_value(args.base_url, "BBTODO_BASE_URL", env_file_values)
    base_url = normalize_base_url(raw_base_url) if raw_base_url else ""
    api_token, api_token_source = resolve_api_token(getattr(args, "api_token", None), env_file_values)
    project_name = resolve_config_value(
        args.project_name,
        "BBTODO_PROJECT_NAME",
        env_file_values,
        default_project_name(worktree),
    ).strip()
    if not project_name:
        raise BBTodoError("Project name cannot be empty.")

    active_lane = resolve_config_value(args.active_lane, "BBTODO_ACTIVE_LANE", env_file_values, "In Progress")
    review_lane = resolve_config_value(args.review_lane, "BBTODO_REVIEW_LANE", env_file_values, "In review")
    start_lane = resolve_config_value(args.start_lane, "BBTODO_START_LANE", env_file_values, "Todo")
    state_root_value = resolve_config_value(
        None,
        "BBTODO_STATE_ROOT",
        env_file_values,
        str(Path.home() / ".codex" / "state" / "bbtodo-skill"),
    )
    state_root = expand_config_path(state_root_value, base_dir=env_file.parent)
    state_file = resolve_state_file(worktree, args.state_key, state_root)

    return ScriptConfig(
        active_lane=active_lane,
        api_token=api_token,
        api_token_source=api_token_source,
        base_url=base_url,
        env_file=env_file,
        project_name=project_name,
        review_lane=review_lane,
        start_lane=start_lane,
        state_file=state_file,
        worktree=worktree,
    )


def command_start(args: argparse.Namespace) -> None:
    config = build_config(args)
    require_api_token(config)
    require_base_url(config)

    request_body = read_text_argument(args.body, args.body_file)
    client = BBTodoClient(config.base_url, config.api_token)
    requested_ticket_id = str(args.ticket_id or "").strip()
    requested_title = str(args.title or "").strip()
    created_project = False

    if requested_ticket_id:
        task = client.get_task_by_ticket_id(requested_ticket_id)
        project = get_project_by_id(client, str(task.get("projectId") or "").strip())
    else:
        if not requested_title:
            raise BBTodoError("Task title cannot be empty.")
        project, created_project = get_or_create_project(client, config.project_name)
        task = {}

    lanes = client.list_lanes(project["id"])
    start_lane = get_lane(lanes, config.start_lane)
    active_lane = get_lane(lanes, config.active_lane)
    review_lane = get_lane(lanes, config.review_lane)
    existing_state = load_state(config.state_file)

    action = "created"

    if requested_ticket_id:
        requested_title = str(task.get("title") or "").strip()
        task = client.update_task(
            project["id"],
            str(task["id"]),
            {
                "body": build_attached_start_body(str(task.get("body") or ""), request_body, config.worktree),
                "laneId": start_lane["id"],
            },
        )
        action = "attached"
    else:
        body_text = build_start_body(request_body, config.worktree)
        payload = {
            "body": body_text,
            "laneId": start_lane["id"],
            "title": requested_title,
        }

        can_reuse_existing = (
            existing_state is not None
            and existing_state.get("baseUrl") == client.base_url
            and existing_state.get("project", {}).get("id") == project["id"]
            and existing_state.get("task", {}).get("id")
        )
        existing_task_in_review = False
        if can_reuse_existing:
            existing_task_in_review = is_task_in_review(client, project["id"], review_lane, existing_state)

        if can_reuse_existing and existing_task_in_review:
            existing_title = str(existing_state.get("task", {}).get("title") or "")
            if titles_match(existing_title, requested_title):
                task_id = str(existing_state["task"]["id"])
                try:
                    existing_task = get_task(client, project["id"], task_id)
                    payload["body"] = build_resume_body(str(existing_task.get("body") or ""), request_body)
                    task = client.update_task(project["id"], task_id, payload)
                    action = "reopened"
                except BBTodoError as exc:
                    if "404" not in str(exc) and "no longer exists" not in str(exc):
                        raise
                    task = client.create_task(project["id"], payload)
            else:
                task = client.create_task(project["id"], payload)
        elif can_reuse_existing:
            task_id = str(existing_state["task"]["id"])
            try:
                task = client.update_task(project["id"], task_id, payload)
                action = "updated"
            except BBTodoError as exc:
                if "404" not in str(exc) and "no longer exists" not in str(exc):
                    raise
                task = client.create_task(project["id"], payload)
        else:
            task = client.create_task(project["id"], payload)

    state = {
        "activeLane": {
            "id": active_lane["id"],
            "name": active_lane.get("name", config.active_lane),
        },
        "baseUrl": client.base_url,
        "currentLane": {
            "id": start_lane["id"],
            "name": start_lane.get("name", config.start_lane),
        },
        "project": {
            "id": project["id"],
            "name": project["name"],
            "url": f"{client.base_url}/projects/{project['id']}",
        },
        "reviewLane": {
            "id": review_lane["id"],
            "name": review_lane.get("name", config.review_lane),
        },
        "startLane": {
            "id": start_lane["id"],
            "name": start_lane.get("name", config.start_lane),
        },
        "task": {},
        "worktree": config.worktree,
    }
    ticket_id = update_state_task_metadata(state, task)
    save_state(config.state_file, state)

    print(
        json.dumps(
            {
                "action": action,
                "createdProject": created_project,
                "envFile": str(config.env_file),
                "projectId": project["id"],
                "projectName": project["name"],
                "projectUrl": f"{client.base_url}/projects/{project['id']}",
                "stateFile": str(config.state_file),
                "targetLane": start_lane.get("name", config.start_lane),
                "taskId": task["id"],
                "taskTitle": task["title"],
                "ticketId": ticket_id,
            },
            indent=2,
            sort_keys=True,
        )
    )


def command_begin_work(args: argparse.Namespace) -> None:
    config = build_config(args)
    require_api_token(config)
    state = load_state(config.state_file)
    if not state:
        raise BBTodoError(f"No active work item state found at {config.state_file}. Run start first.")

    project_id, task_id, project_name, project_url = require_tracked_task_context(state, config.state_file)
    client = BBTodoClient(str(state.get("baseUrl") or config.base_url), config.api_token)
    active_lane_name = args.active_lane or str(state.get("activeLane", {}).get("name") or config.active_lane)

    lanes = client.list_lanes(project_id)
    active_lane = get_lane(lanes, active_lane_name)
    updated_task = client.update_task(project_id, task_id, {"laneId": active_lane["id"]})

    state["activeLane"] = {
        "id": active_lane["id"],
        "name": active_lane.get("name", active_lane_name),
    }
    state["currentLane"] = {
        "id": active_lane["id"],
        "name": active_lane.get("name", active_lane_name),
    }
    ticket_id = update_state_task_metadata(state, updated_task)
    save_state(config.state_file, state)

    print(
        json.dumps(
            {
                "action": "began-work",
                "envFile": str(config.env_file),
                "projectId": project_id,
                "projectName": project_name,
                "projectUrl": project_url,
                "stateFile": str(config.state_file),
                "targetLane": active_lane.get("name", active_lane_name),
                "taskId": updated_task["id"],
                "taskTitle": updated_task["title"],
                "ticketId": ticket_id,
            },
            indent=2,
            sort_keys=True,
        )
    )


def command_resume_current(args: argparse.Namespace) -> None:
    config = build_config(args)
    require_api_token(config)
    state = load_state(config.state_file)
    if not state:
        raise BBTodoError(f"No saved work item state found at {config.state_file}. Run start first.")

    project_id, task_id, project_name, project_url = require_tracked_task_context(state, config.state_file)
    client = BBTodoClient(str(state.get("baseUrl") or config.base_url), config.api_token)
    active_lane_name = args.active_lane or str(state.get("activeLane", {}).get("name") or config.active_lane)
    details = read_text_argument(args.details, args.details_file)

    lanes = client.list_lanes(project_id)
    active_lane = get_lane(lanes, active_lane_name)
    task = get_task(client, project_id, task_id)
    updated_task = client.update_task(
        project_id,
        task_id,
        {
            "body": build_resume_body(str(task.get("body", "")), details),
            "laneId": active_lane["id"],
        },
    )

    state["currentLane"] = {
        "id": active_lane["id"],
        "name": active_lane.get("name", active_lane_name),
    }
    ticket_id = update_state_task_metadata(state, updated_task)
    save_state(config.state_file, state)

    print(
        json.dumps(
            {
                "action": "resumed",
                "envFile": str(config.env_file),
                "projectId": project_id,
                "projectName": project_name,
                "projectUrl": project_url,
                "stateFile": str(config.state_file),
                "targetLane": active_lane.get("name", active_lane_name),
                "taskId": updated_task["id"],
                "taskTitle": updated_task["title"],
                "ticketId": ticket_id,
            },
            indent=2,
            sort_keys=True,
        )
    )


def command_finish(args: argparse.Namespace) -> None:
    config = build_config(args)
    require_api_token(config)
    state = load_state(config.state_file)
    if not state:
        raise BBTodoError(f"No active work item state found at {config.state_file}. Run start first.")

    project_id, task_id, project_name, project_url = require_tracked_task_context(state, config.state_file)
    client = BBTodoClient(str(state.get("baseUrl") or config.base_url), config.api_token)
    review_lane_name = args.review_lane or str(state.get("reviewLane", {}).get("name") or config.review_lane)
    review_note = read_text_argument(args.append_note, args.append_note_file)
    branch_name = detect_git_branch(config.worktree)

    lanes = client.list_lanes(project_id)
    review_lane = get_lane(lanes, review_lane_name)
    task = get_task(client, project_id, task_id)
    updated_task = client.update_task(
        project_id,
        task_id,
        {
            "body": build_finish_body(str(task.get("body", "")), review_note, branch_name),
            "laneId": review_lane["id"],
        },
    )

    clear_state = bool(args.clear_state)
    if clear_state:
        delete_state(config.state_file)
        ticket_id = extract_ticket_id(updated_task, state.get("task", {}).get("ticketId"))
    else:
        state["currentLane"] = {
            "id": review_lane["id"],
            "name": review_lane.get("name", review_lane_name),
        }
        ticket_id = update_state_task_metadata(state, updated_task)
        save_state(config.state_file, state)

    print(
        json.dumps(
            {
                "action": "finished",
                "clearedState": clear_state,
                "envFile": str(config.env_file),
                "gitBranch": branch_name,
                "projectId": project_id,
                "projectName": project_name,
                "projectUrl": project_url,
                "stateFile": str(config.state_file),
                "targetLane": review_lane.get("name", review_lane_name),
                "taskId": updated_task["id"],
                "taskTitle": updated_task["title"],
                "ticketId": ticket_id,
            },
            indent=2,
            sort_keys=True,
        )
    )


def command_status(args: argparse.Namespace) -> None:
    config = build_config(args)
    state = load_state(config.state_file)
    print(
        json.dumps(
            {
                "apiTokenSource": config.api_token_source,
                "envFile": str(config.env_file),
                "envFileExists": config.env_file.exists(),
                "exists": state is not None,
                "state": state,
                "stateFile": str(config.state_file),
                "tokenConfigured": bool(config.api_token),
            },
            indent=2,
            sort_keys=True,
        )
    )


def command_token_status(args: argparse.Namespace) -> None:
    config = build_config(args)
    payload: dict[str, Any] = {
        "apiTokenSource": config.api_token_source,
        "baseUrl": config.base_url,
        "envFile": str(config.env_file),
        "envFileExists": config.env_file.exists(),
        "exists": bool(config.api_token),
    }
    messages: list[str] = []
    if not config.api_token:
        messages.append(f"Add BBTODO_API_TOKEN to {config.env_file} or pass --api-token.")
    if not config.base_url:
        messages.append(f"Add BBTODO_BASE_URL to {config.env_file} or pass --base-url.")
    if messages:
        payload["message"] = " ".join(messages)
    print(json.dumps(payload, indent=2, sort_keys=True))


def command_clear_state(args: argparse.Namespace) -> None:
    config = build_config(args)
    existed = config.state_file.exists()
    delete_state(config.state_file)
    print(
        json.dumps(
            {
                "action": "cleared",
                "existed": existed,
                "stateFile": str(config.state_file),
            },
            indent=2,
            sort_keys=True,
        )
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create and advance tracked BBTodo tasks for Codex work.")
    parser.add_argument("--api-token", help="Use a one-off API token for this command.")
    parser.add_argument("--active-lane", help="Override the active work lane name for this command.")
    parser.add_argument("--base-url", help="Override the BBTodo base URL for this command.")
    parser.add_argument("--project-name", help="Override the target project name for this command.")
    parser.add_argument("--review-lane", help="Override the review lane name for this command.")
    parser.add_argument("--start-lane", help="Override the start lane name for this command.")
    parser.add_argument("--state-key", help="Override the derived state key for this command.")
    parser.add_argument("--worktree", help="Override the working directory associated with the state file.")

    subparsers = parser.add_subparsers(dest="command", required=True)

    token_status_parser = subparsers.add_parser(
        "token-status",
        help="Check whether a usable API token is configured through CLI, environment, or scripts/.env.",
    )
    token_status_parser.set_defaults(func=command_token_status)

    start_parser = subparsers.add_parser("start", help="Create or update the tracked BBTodo task.")
    start_parser.add_argument("--body", help="Markdown body for the task.")
    start_parser.add_argument("--body-file", help="Path to a file containing the markdown body.")
    start_target_group = start_parser.add_mutually_exclusive_group(required=True)
    start_target_group.add_argument("--ticket-id", help="Attach the worktree to an existing BBTodo ticket.")
    start_target_group.add_argument("--title", help="Short title for the task.")
    start_parser.set_defaults(func=command_start)

    begin_work_parser = subparsers.add_parser("begin-work", help="Move the tracked task into the active lane.")
    begin_work_parser.set_defaults(func=command_begin_work)

    resume_parser = subparsers.add_parser(
        "resume-current",
        help="Append follow-up details to the tracked task and move it back to the active lane.",
    )
    resume_parser.add_argument("--details", help="Markdown details appended to the follow-up section.")
    resume_parser.add_argument("--details-file", help="Path to a file containing follow-up details.")
    resume_parser.set_defaults(func=command_resume_current)

    finish_parser = subparsers.add_parser("finish", help="Move the tracked task into the review lane.")
    finish_parser.add_argument("--append-note", help="Markdown note appended as the review handoff.")
    finish_parser.add_argument("--append-note-file", help="Path to a file containing the review handoff note.")
    finish_parser.add_argument(
        "--clear-state",
        action="store_true",
        help="Delete the local state after moving the task to the review lane when the issue is truly done.",
    )
    finish_parser.set_defaults(func=command_finish)

    status_parser = subparsers.add_parser("status", help="Print the saved local task state.")
    status_parser.set_defaults(func=command_status)

    clear_state_parser = subparsers.add_parser("clear-state", help="Delete the saved local task state.")
    clear_state_parser.set_defaults(func=command_clear_state)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        args.func(args)
    except BBTodoError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
