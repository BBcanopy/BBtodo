import json
import os
from pathlib import Path
import re
import subprocess


DEPENDABOT = "dependabot[bot]"
UPDATE_TYPES = {"version-update:semver-minor", "version-update:semver-patch"}


def eligible_commit(commit):
    details = commit["commit"]
    if (commit.get("author") or {}).get("login") != DEPENDABOT:
        return False
    if not details["verification"]["verified"]:
        return False

    # Dependabot appends its YAML metadata before the sign-off trailer.
    _, marker, tail = details["message"].rpartition("\n---\nupdated-dependencies:\n")
    metadata, end, _ = tail.partition("\n...\n")
    if not marker or not end or not metadata.startswith("- dependency-name:"):
        return False

    entries = re.split(r"(?m)^- dependency-name:", metadata)[1:]
    for entry in entries:
        update_types = re.findall(r"(?m)^  update-type:[ \t]+(\S+)[ \t]*$", entry)
        if len(update_types) != 1 or update_types[0] not in UPDATE_TYPES:
            return False
    return True


def auto_merge(event, api):
    repository = event["repository"]
    run = event["workflow_run"]
    if (
        run["path"] != ".github/workflows/ci.yml"
        or run["event"] != "pull_request"
        or run["conclusion"] != "success"
        or run["actor"]["login"] != DEPENDABOT
        or (run.get("head_repository") or {}).get("id") != repository["id"]
    ):
        return False

    repo = f"repos/{repository['full_name']}"
    sha = run["head_sha"]
    pulls = api(f"{repo}/commits/{sha}/pulls")
    candidates = [
        pr for pr in pulls
        if pr["state"] == "open"
        and not pr["draft"]
        and pr["user"]["login"] == DEPENDABOT
        and pr["head"]["sha"] == sha
        and pr["head"]["ref"] == run["head_branch"]
        and pr["head"]["repo"]["id"] == repository["id"]
        and pr["base"]["ref"] == "main"
        and pr["base"]["repo"]["id"] == repository["id"]
    ]
    if len(candidates) != 1:
        print("No open Dependabot PR on main matches this CI run.")
        return False

    number = candidates[0]["number"]
    pull = f"{repo}/pulls/{number}"
    pages = api(f"{pull}/commits?per_page=100", "--paginate", "--slurp")
    commits = [commit for page in pages for commit in page]
    if not commits or commits[-1]["sha"] != sha or not all(map(eligible_commit, commits)):
        print(f"PR #{number} is outside the verified minor and patch update policy.")
        return False

    # Ignore superseded runs, including newer attempts on the same head.
    runs = api(f"{repo}/actions/workflows/ci.yml/runs?event=pull_request&head_sha={sha}&per_page=1")
    latest = next(iter(runs["workflow_runs"]), {})
    if (
        latest.get("id") != run["id"]
        or latest.get("run_attempt") != run["run_attempt"]
        or latest.get("conclusion") != "success"
    ):
        print(f"PR #{number} is waiting for a successful current CI run.")
        return False

    merged = api(f"{pull}/merge", "--method", "PUT", "-f", f"sha={sha}", "-f", "merge_method=merge")
    if not merged["merged"]:
        raise RuntimeError(f"GitHub declined the merge of PR #{number}: {merged['message']}")

    print(f"Merged PR #{number}.")
    return True


def api(endpoint, *args):
    result = subprocess.run(
        ["gh", "api", endpoint, *args], check=True,
        stdout=subprocess.PIPE, encoding="utf-8",
    )
    return json.loads(result.stdout) if result.stdout else None


if __name__ == "__main__":
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    if auto_merge(event, api):
        with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
            output.write("merged=true\n")
