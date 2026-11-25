# Verify Report: Manual Monitor Run

## Status

Complete with one authorized visual-review exception. No production defect was
found in the reviewed PR chain. The exact OpenPencil `.fig` comparison was not
performed and is recorded as deferred visual-refinement work rather than as
verification evidence.

## Verified Evidence

- PR #21 through #25 form a continuous open, mergeable feature-branch chain.
- PR #25 is at `a3e969948e976ae636dcaba41a72d14b4dedb2c8`; its delta from
  `40b0971ee480bd186da98509da5f3ff4650fc7cf` is a copy-only correction.
- Focused UI tests passed (10/10), direct unit tests passed (188/188), focused
  coordinator/handler/engine tests passed (43/43), and native HTTP/HTTPS
  loopback transport tests passed (26/26).
- An authorized temporary Next.js server was run from `apps/web` on
  `127.0.0.1:3000`. Playwright Run Now E2E passed (8/8) in a real browser.
  API responses were intercepted by Playwright, so this verifies browser UI
  behavior rather than the Route Handler, Redis, or Check Engine as one stack.
- TypeScript closure with CLI-only `--allowImportingTsExtensions` passed. The
  literal typecheck retains only known baseline TS5097 diagnostics for `.ts`
  imports. Literal `pnpm test` remains blocked before Vitest by pnpm
  metadata/no-TTY behavior.

## Excepted Evidence

- Two bounded read-only OpenPencil attempts timed out, so the required exact
  desktop/mobile comparison with `design/openpencil/api-watchdog-dashboard-v1.fig`
  was not observed. The maintainer explicitly accepted this exception after
  reviewing captured desktop/mobile browser results; the comparison remains
  deferred and is not claimed as completed.

## Isolated Cross-Slice Evidence (2026-11-25)

- An authorized isolated PostgreSQL database, Redis, and Next.js server were
  subsequently used with synthetic records. Real non-intercepted browser and
  route requests proved ACTIVE and PAUSED runs, uniform cross-project/missing
  404 responses, cooldown behavior, owner lease release, and transient
  redacted `dns_failure` presentation for loopback targets. Those loopback
  outcomes confirm SSRF remains enabled; they are not successful transport
  proof.
- One authorized real HTTPS Run Now request to `https://httpbin.org/status/200`
  completed with a typed UI result of `success`, HTTP 200, and 659 ms. Its
  lease was absent afterwards, the project ZSET was empty, the cooldown key was
  present, and the monitor timestamp did not change.
- Real Redis Lua capacity evidence used three prepared, token-owned leases from
  the production script. The fourth Project-A route request returned 429
  `PROJECT_CONCURRENCY_LIMIT`; a Project-B run remained admitted. Releasing an
  owner lease restored capacity, and all prepared leases/ZSET entries were
  cleared. This is deliberately not represented as four blocked HTTP requests.
- With isolated Redis stopped, a valid route request returned redacted 503
  `RUN_COORDINATION_UNAVAILABLE` before Check Engine execution. The original
  container auto-removed on stop, so a new equivalent loopback-only temporary
  Redis container was created without `--rm`. Without restarting Next.js, a
  subsequent valid loopback run returned 200 typed `dns_failure`; no lease
  remained, its cooldown was set, and the monitor remained unchanged. This
  proves fail-closed behavior and a later independent coordinator recovery.

## Task Reconciliation

- Task 3.4 is complete under the authorized exception: its functional,
  accessibility, browser, and regression evidence is verified; only the exact
  `.fig` comparison is deferred.
- Final Cross-Slice Verification is complete: the real route/Redis/engine
  chain, browser UI, SSRF rejection, successful HTTPS, capacity, fail-closed
  Redis behavior, and recovery are evidenced. Project scoping remains an
  isolation boundary, not authentication or authorization.

## Safety

The UI continues to display only narrow redacted result fields, treats project
scoping as isolation rather than authorization, makes results transient, and
does not add persistence, scheduler, workers, BullMQ jobs, history, alerts, or
external-target tests.

## Integration (2026-11-25)

All five chained PRs were merged with merge commits, in order, onto `main`:

| PR | Merge commit |
| --- | --- |
| #21 | `641e764ea0e9359712775887464783e9745bc1e1` |
| #22 | `81b0b37342235548e9e670e1e0516f7d85b821cd` |
| #23 | `182ff86bfdc00622b098c235ea62e3462d967860` |
| #24 | `bd820b28252090f80bfa6984e3c1e60e65701059` |
| #25 | `11e3c7928a4ece61809c4aee4bebfd246f30cdde` |

The final `main` HEAD is `11e3c7928a4ece61809c4aee4bebfd246f30cdde`.
Each reviewed PR head is an ancestor of that commit; no squash, rebase,
cherry-pick, force-push, or branch deletion was used. A focused Run Now unit
check against an isolated worktree with the same final tree passed 37/37.
The authorized OpenPencil exception remains unchanged; archiving is deferred
until the maintainer confirms post-integration closure.
