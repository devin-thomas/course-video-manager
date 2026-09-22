# Backlog: GitHub

Issues and PRDs for this repo live as GitHub issues in **`devin-thomas/course-video-manager`** (this fork). Use the `gh` CLI for all operations.

This clone has two remotes — `origin` (the fork) and `upstream` (`mattpocock/course-video-manager`) — so `gh` cannot be trusted to infer the right repo. **Always pass `-R devin-thomas/course-video-manager`** (or use `repos/devin-thomas/course-video-manager/...` with `gh api`). Never file issues, PRs or comments on the upstream repo. A local `gh repo set-default devin-thomas/course-video-manager` is a convenience, not a substitute: fresh clones and CI runners don't have it.

## Conventions

Every command below takes `-R devin-thomas/course-video-manager`; for brevity it is written as `$R`, as if you had run `R="-R devin-thomas/course-video-manager"` (unquoted `$R` expands to both words).

- **Create an issue**: `gh issue create $R --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> $R --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list $R --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> $R --body "..."`
- **Apply / remove labels**: `gh issue edit <number> $R --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> $R --comment "..."`
- **Sub-issues** (PRD → slices): `gh api repos/devin-thomas/course-video-manager/issues/<PRD>/sub_issues`.

Label vocabulary: [triage-labels.md](./triage-labels.md).

## When a skill says "publish to the backlog"

Create a GitHub issue in `devin-thomas/course-video-manager`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> -R devin-thomas/course-video-manager --comments`.
