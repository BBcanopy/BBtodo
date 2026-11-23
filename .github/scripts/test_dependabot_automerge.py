import unittest
from unittest.mock import Mock

from dependabot_automerge import DEPENDABOT, auto_merge, eligible_commit


SHA = "a" * 40
BRANCH = "dependabot/npm_and_yarn/server/package-1.2.3"
REPO = "repos/owner/repo"


def dependabot_commit(*update_types):
    entries = "\n".join(
        f"- dependency-name: package-{index}\n  update-type: version-update:semver-{update_type}"
        for index, update_type in enumerate(update_types)
    )
    return {
        "sha": SHA,
        "author": {"login": DEPENDABOT},
        "commit": {
            "message": f"Bump dependencies\n\n---\nupdated-dependencies:\n{entries}\n...\n\nSigned-off-by: Dependabot",
            "verification": {"verified": True},
        },
    }


class CommitTests(unittest.TestCase):
    def test_all_updates_must_be_minor_or_patch(self):
        self.assertTrue(eligible_commit(dependabot_commit("minor", "patch")))
        self.assertFalse(eligible_commit(dependabot_commit("patch", "major")))
        self.assertFalse(eligible_commit(dependabot_commit("unknown")))
        self.assertFalse(eligible_commit(dependabot_commit()))

    def test_unsigned_or_non_dependabot_commit_is_rejected(self):
        commit = dependabot_commit("patch")
        commit["commit"]["verification"]["verified"] = False
        self.assertFalse(eligible_commit(commit))
        commit["commit"]["verification"]["verified"] = True
        commit["author"]["login"] = "contributor"
        self.assertFalse(eligible_commit(commit))


class AutoMergeTests(unittest.TestCase):
    def setUp(self):
        self.run = {
            "id": 123,
            "run_attempt": 1,
            "path": ".github/workflows/ci.yml",
            "event": "pull_request",
            "conclusion": "success",
            "actor": {"login": DEPENDABOT},
            "head_repository": {"id": 42},
            "head_sha": SHA,
            "head_branch": BRANCH,
        }
        self.event = {
            "repository": {"id": 42, "full_name": "owner/repo"},
            "workflow_run": self.run,
        }
        self.pull = {
            "number": 7,
            "state": "open",
            "draft": False,
            "user": {"login": DEPENDABOT},
            "head": {"sha": SHA, "ref": BRANCH, "repo": {"id": 42}},
            "base": {"ref": "main", "repo": {"id": 42}},
        }

    def test_green_patch_merges_exact_head(self):
        api = Mock(side_effect=[
            [self.pull], [[dependabot_commit("patch")]], {"workflow_runs": [self.run]},
            {"merged": True},
        ])
        self.assertTrue(auto_merge(self.event, api))
        api.assert_called_with(
            f"{REPO}/pulls/7/merge", "--method", "PUT", "-f", f"sha={SHA}", "-f", "merge_method=merge",
        )

    def test_failed_ci_does_not_merge(self):
        self.run["conclusion"] = "failure"
        api = Mock()
        self.assertFalse(auto_merge(self.event, api))
        api.assert_not_called()

    def test_changed_head_does_not_merge(self):
        self.pull["head"]["sha"] = "b" * 40
        api = Mock(side_effect=[[self.pull]])
        self.assertFalse(auto_merge(self.event, api))
        self.assertEqual(api.call_count, 1)

    def test_major_update_does_not_merge(self):
        api = Mock(side_effect=[[self.pull], [[dependabot_commit("major")]]])
        self.assertFalse(auto_merge(self.event, api))
        self.assertEqual(api.call_count, 2)

    def test_superseded_ci_attempt_does_not_merge(self):
        latest = {**self.run, "run_attempt": 2, "conclusion": None}
        api = Mock(side_effect=[
            [self.pull], [[dependabot_commit("minor")]], {"workflow_runs": [latest]},
        ])
        self.assertFalse(auto_merge(self.event, api))
        self.assertEqual(api.call_count, 3)
