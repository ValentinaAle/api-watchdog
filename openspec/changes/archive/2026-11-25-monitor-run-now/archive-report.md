# Archive Report: Manual Monitor Run

## Final State

`monitor-run-now` was integrated into `main` on 2026-11-25. All 20 task
items are closed: 19 have directly observed verification evidence, and task
3.4 is closed under an explicit maintainer-approved exception.

The exact comparison against
`design/openpencil/api-watchdog-dashboard-v1.fig` was not performed after two
bounded OpenPencil MCP attempts timed out. Desktop/mobile captures,
real-browser Playwright evidence, and maintainer manual review were accepted
for the task. The `.fig` comparison remains deferred visual-refinement work;
this archive does not represent it as completed.

## Integration Evidence

| PR | Merge commit |
| --- | --- |
| #21 | `641e764ea0e9359712775887464783e9745bc1e1` |
| #22 | `81b0b37342235548e9e670e1e0516f7d85b821cd` |
| #23 | `182ff86bfdc00622b098c235ea62e3462d967860` |
| #24 | `bd820b28252090f80bfa6984e3c1e60e65701059` |
| #25 | `11e3c7928a4ece61809c4aee4bebfd246f30cdde` |

Final `main` is `11e3c7928a4ece61809c4aee4bebfd246f30cdde`. The reviewed PR
heads are ancestors of that commit. Integration used merge commits only; no
squash, rebase, cherry-pick, force-push, or branch deletion occurred.

## Verification Summary

Observed evidence covers Redis admission/recovery, project capacity, token
ownership, scoped Route Handler behavior, SSRF rejection, HTTPS success,
transient redacted UI results, and absence of result persistence. A focused
Run Now unit check on a worktree whose tree matched final `main` passed 37/37.

Known environmental limitations remain documented: literal `pnpm test` is
blocked before Vitest by pnpm metadata/no-TTY behavior, and literal TypeScript
has baseline TS5097 `.ts` import diagnostics. Equivalent direct evidence is
recorded in the retained verify report.

## Artifact Traceability

Engram observations retained for this change include proposal #154, spec #155,
design #156, tasks #157, apply-progress #160, verify-report #203, and this
archive report. The canonical OpenSpec specification is now
`openspec/specs/manual-monitor-run/spec.md`; this archived folder preserves
the original planning and verification artifacts.
