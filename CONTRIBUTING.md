# Contributing

## Merge process (how reviews are enforced)

`main` is protected: every change lands via PR, all checks in `all-checks-passed`
must be green, and **all review conversations must be resolved** before merge
(`required_conversation_resolution`).

Copilot reviews every PR automatically, but that review is **asynchronous** — it
can post *after* a PR is otherwise mergeable. So immediate auto-merge can race
past it. To prevent that:

- **Do not `gh pr merge --auto` substantive PRs.** Open the PR, then wait for
  Copilot's review to land.
- Triage every Copilot comment: fix it, or reply explaining why it's a non-issue.
- Resolve each thread (the conversation-resolution gate then lets the PR merge).
- Only then merge (`gh pr merge --squash --delete-branch`).

Trivial PRs (docs, comments) may auto-merge. Anything touching the data plane,
auth, Helm, or CI goes through the review-then-merge loop above.

## Build / test

See `CLAUDE.md` for the per-service build/test/lint commands.
