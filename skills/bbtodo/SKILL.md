---
name: bbtodo
description: Operate the BBTodo app itself for agent work tracking. Use when Codex needs to create a BBTodo task before starting work, move it into In Progress while active work is happening, move it into In review when the work is ready, or resume the same task for follow-up work. This skill manages one tracked task through `scripts/bbtodo.py` and reads its API token from `scripts/.env`.
---

# BBTodo

Use `scripts/bbtodo.py` to keep one tracked BBTodo task aligned with the current worktree.

## Required Config

- Create a personal API token in BBTodo at `/settings/api-tokens`.
- Store the token in `scripts/.env` beside `bbtodo.py`.
- Use `scripts/.env.example` as the template for the required keys.
- If authentication or lane lookup fails, tell the user immediately. Do not pretend the sync succeeded.

Example:

```powershell
Copy-Item .\skills\bbtodo\scripts\.env.example .\skills\bbtodo\scripts\.env
```

```bash
cp ./skills/bbtodo/scripts/.env.example ./skills/bbtodo/scripts/.env
```

Then edit `.\skills\bbtodo\scripts\.env`:

```dotenv
BBTODO_API_TOKEN=replace-with-your-token
BBTODO_BASE_URL=https://bbtodo.example.com
```

`BBTODO_BASE_URL` is required and has no default. Set it to the address of your BBTodo instance, because the helper sends your API token there.

## Workflow

1. Before substantial exploration, editing, or long-running commands, derive a short task title and optional markdown details.
2. Run `python .\skills\bbtodo\scripts\bbtodo.py start ...` to create or reuse the tracked task in `Todo`.
   If the human gives you a ticket ID such as `BBTO-45`, use `start --ticket-id BBTO-45` so the helper fetches the existing task title and description from BBTodo before attaching the worktree.
3. When active work begins, run `python .\skills\bbtodo\scripts\bbtodo.py begin-work`.
4. After the work is ready for review, run `python .\skills\bbtodo\scripts\bbtodo.py finish ...`.
5. If the same issue comes back for follow-up work, run `python .\skills\bbtodo\scripts\bbtodo.py resume-current ...`.
6. Use `token-status`, `status`, and `clear-state` for recovery.

## Start The Task

- Keep the title stable across planning and implementation when it is the same issue.
- When the human references an existing ticket ID, prefer `--ticket-id` instead of inventing a new title. The helper will fetch the current title and body from BBTodo and append the new tracking metadata.
- The helper auto-creates the configured project when it does not exist yet.
- The helper reuses the currently tracked task when local state already points at an active task.
- If the saved task is already in `In review` and `start` is called again with the same title, the helper reopens that same task in `Todo` and appends a follow-up section.

Example:

```powershell
$body = @"
- Goal: tighten lane-delete behavior.
- Plan:
  - inspect the board workflow
  - implement the fix
  - verify the regression stays covered
"@
python .\skills\bbtodo\scripts\bbtodo.py start `
  --title "Fix lane delete flow" `
  --body $body
```

```bash
body=$'- Goal: tighten lane-delete behavior.\n- Plan:\n  - inspect the board workflow\n  - implement the fix\n  - verify the regression stays covered'
python ./skills/bbtodo/scripts/bbtodo.py start \
  --title "Fix lane delete flow" \
  --body "$body"
```

When the user already gave you a ticket ID, attach to that task instead:

```powershell
$body = @"
- Plan:
  - inspect the current issue state
  - implement the requested change
  - verify the affected behavior
"@
python .\skills\bbtodo\scripts\bbtodo.py start `
  --ticket-id "BBTO-45" `
  --body $body
```

```bash
body=$'- Plan:\n  - inspect the current issue state\n  - implement the requested change\n  - verify the affected behavior'
python ./skills/bbtodo/scripts/bbtodo.py start \
  --ticket-id "BBTO-45" \
  --body "$body"
```

## Move Through The Lanes

- Run `begin-work` when active implementation or verification starts. That moves the tracked task into `In Progress`.
- Run `finish` only when the work is genuinely ready for review. Add a short review note when it helps future follow-up.
- Run `resume-current` when the same task needs more work after review. That appends a follow-up note and moves the tracked task back to `In Progress`.

Examples:

```powershell
python .\skills\bbtodo\scripts\bbtodo.py begin-work
```

```bash
python ./skills/bbtodo/scripts/bbtodo.py begin-work
```

```powershell
$note = @"
- Result: fixed the lane delete flow.
- Verification: targeted smoke test plus CLI status check.
"@
python .\skills\bbtodo\scripts\bbtodo.py finish --append-note $note
```

```bash
note=$'- Result: fixed the lane delete flow.\n- Verification: targeted smoke test plus CLI status check.'
python ./skills/bbtodo/scripts/bbtodo.py finish --append-note "$note"
```

```powershell
$details = @"
- Follow-up: one more edge case from review.
"@
python .\skills\bbtodo\scripts\bbtodo.py resume-current --details $details
```

```bash
details=$'- Follow-up: one more edge case from review.'
python ./skills/bbtodo/scripts/bbtodo.py resume-current --details "$details"
```

## Recovery

- Run `python .\skills\bbtodo\scripts\bbtodo.py token-status` to confirm whether the helper can see a token.
- Run `python .\skills\bbtodo\scripts\bbtodo.py status` to inspect the saved local task state.
- Run `python .\skills\bbtodo\scripts\bbtodo.py clear-state` when the saved state is stale and a fresh `start` should create or attach to a new task.
- If the configured lane names are missing, stop and tell the user which lanes exist instead of guessing.
