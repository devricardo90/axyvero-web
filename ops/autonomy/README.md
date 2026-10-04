# AXYVERO autonomous production runner

Project-specific composition for `devricardo90/axyvero-web`. It reuses the proven SouzaLoop runtime/lifecycle as an external engine without modifying `souza-lab`.

Target flow:

`Jira AXY -> Loop runtime -> Hermes coder -> GitHub PR/CI -> validator -> Hermes reviewer -> correction loop -> merge -> post-merge validation -> Jira Feito -> next AXY issue`.

The runner also bootstraps the minimal GitHub Actions workflow on the first execution branch when it is absent, so AXY-1 is not blocked waiting for AXY-4.

Runtime state is stored under `/opt/data/axyvero`. Jira credentials remain in `/opt/data/secrets/jira-email` and `/opt/data/secrets/jira-token`.

The automation branch is intentionally separate from `main` while the current checkpoint is active.
