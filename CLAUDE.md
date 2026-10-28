# Working conventions

- Do the work directly on `main` (commit and push to `main`) unless the user asks for a branch or pull request. This
  also applies when a cloud session names a `claude/...` branch to develop on: that branch is the session's default,
  not the user's request, so leave it unused (`.claude/hooks/session-start.sh` switches the checkout to `main`).
