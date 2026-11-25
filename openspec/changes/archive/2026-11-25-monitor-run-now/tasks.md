# Tasks: Manual Monitor Run

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | 810–1,050 authored lines across three slices |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 Redis coordination → PR 2 secure Route Handler / Check Engine → PR 3 detail UI / E2E |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending (recommended: feature-branch-chain) |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

The implementation must use isolated worktrees created from an updated `main` that contains the archived HTTP Check Engine. The user must choose the chain strategy before `sdd-apply`; this plan recommends a feature-branch chain because all three deliverables form one bounded manual-execution capability and later slices depend on the previous server contracts.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Atomic Redis admission and owner-safe release | PR 1, base = feature/tracker branch | `vitest run tests/unit/manual-run-coordinator.test.ts` | Concurrent injected Lua-script client; no live Redis required | `run-coordinator.ts` and its unit test |
| 2 | Secure Node.js manual-run route backed by the Check Engine | PR 2, base = PR 1 branch | `vitest run tests/unit/manual-run-handler.test.ts` | Injected repository, coordinator, Check Engine resolver/transport; test DB only where existing route harness requires it | route, run service, engine cancellation seam, and route tests |
| 3 | Accessible transient Monitor Detail Run Now interaction | PR 3, base = PR 2 branch | `playwright test tests/e2e/monitor-run-now.spec.ts` | Intercepted project-scoped Route Handler responses; no public HTTP or live Redis | client DTO helpers, `MonitorDetail`, and E2E/UI tests |

## Traceability

| Requirement / scenarios from `manual-monitor-run` spec | Planned tasks |
|---|---|
| Project-Scoped Manual Execution API (ACTIVE, PAUSED, persisted-only input, body rejection) | 2.1–2.5 |
| Project Isolation and Not-Found Semantics | 2.2–2.3, 2.6 |
| Stable Redacted Result Contract | 2.4–2.6, 3.1–3.2 |
| Atomic Manual-Run Admission and Ownership | 1.1–1.5, 2.4–2.5 |
| Project Concurrency Limit | 1.1–1.5, 2.5, 3.3 |
| Bounded Execution and Cancellation | 1.3, 2.4–2.6 |
| Transient Accessible Monitor-Detail Experience | 3.1–3.4 |
| Scope Boundaries and Non-Persistence | 2.5, 3.1–3.4 |

## Slice 1 — Redis Coordination (PR 1)

### 1.1 Define coordination contracts and write RED admission tests

- [x] Create `apps/web/lib/monitors/run-coordinator.ts` with server-only types, stable admission codes (`RUN_IN_PROGRESS`, `RUN_COOLDOWN`, `PROJECT_CONCURRENCY_LIMIT`, `RUN_COORDINATION_UNAVAILABLE`), key derivation, `LEASE_TTL_MS = 15_000`, `COOLDOWN_TTL_MS = 30_000`, project cap `3`, opaque-owner generation seam, and injected Redis-script interface.
  - **Dependencies:** HTTP Check Engine integrated on the eventual base; no route or UI dependency.
  - **Acceptance:** contracts contain no target/monitor transport input, do not expose Redis errors, and cannot be imported by browser code.
  - **Files:** `apps/web/lib/monitors/run-coordinator.ts` (create).
- [x] RED: Create `tests/unit/manual-run-coordinator.test.ts` with deterministic serialized-script-client cases that initially fail for one atomic admission evaluation: same-monitor concurrent `Promise.all`, cooldown at 29,999/30,000 ms from admission, three owners versus a rejected fourth project monitor, no mutation on rejection, unavailable/malformed Redis replies, and expired ZSET owner pruning.
  - **Dependencies:** 1.1 contract.
  - **Acceptance:** tests launch concurrent promises behind an explicit barrier rather than sequential setup; no live Redis, network, Docker, or public HTTP is used.
  - **Spec evidence:** atomic-admission, concurrent-same-monitor, cooldown, project-capacity, unavailable/partial-failure scenarios.

### 1.2 Implement atomic owner-safe Lua admission

- [x] GREEN: Add the admission Lua script and `acquire()` implementation in `apps/web/lib/monitors/run-coordinator.ts`. In exactly one script evaluation, prune expired project ZSET entries, reject active monitor first, reject cooldown second, reject a fourth owner third, and only then create the monitor lease, cooldown, owner ZSET member, and bounded ZSET expiry.
  - **Dependencies:** 1.1.
  - **Acceptance:** successful admission produces one fresh owner token; a rejected request creates no active lease, cooldown, or project contribution; any command/transport/malformed script reply maps to unavailable and prevents execution.
  - **Tests:** turn 1.1 RED cases GREEN and assert script keys/arguments include finite TTLs and the admission timestamp.
  - **Spec evidence:** one active run per monitor; 30-second admission-based cooldown; maximum three active project runs; fail-closed coordination.

### 1.3 Implement owner-checked release and expiry safety

- [x] RED: Extend `tests/unit/manual-run-coordinator.test.ts` with a late-owner/successor case, idempotent double release, release after lease expiry, and release failure after admission. Assert that owner A cannot remove monitor or project state for owner B and that stale ZSET entries do not permanently consume capacity.
  - **Dependencies:** 1.2.
  - **Acceptance:** the test records distinct owner tokens and ZSET members; it fails if release deletes by monitor ID alone or decrements a shared counter.
- [x] GREEN: Add owner-checked Lua release in `apps/web/lib/monitors/run-coordinator.ts`: delete the monitor lease only if its value equals the owner token, remove only that owner’s ZSET member, and return an idempotent server-only completion indicator.
  - **Dependencies:** 1.2 and 1.3 RED.
  - **Acceptance:** late callbacks cannot release a successor; release failure is non-sensitive and bounded by the 15-second lease rather than a local fallback.
  - **Tests:** all ownership, expiry, idempotency, and cleanup RED cases pass.
  - **Risk checkpoint:** prove `15_000 ms >= 10_000 ms` Check Engine deadline plus the bounded handler cleanup path. If repository/runtime evidence shows cleanup can require more than five seconds after the engine deadline, stop this slice and amend design/tasks before implementing a different lease policy.

### 1.4 Wire the production Redis client without creating queues or jobs

- [x] Add the narrow server-only production factory in `apps/web/lib/monitors/run-coordinator.ts` using the existing `@api-watchdog/queue` Redis connection primitive and server configuration at use time; do not create BullMQ queues, workers, scheduler jobs, or in-memory fallback state.
  - **Dependencies:** 1.2–1.3.
  - **Files:** `apps/web/lib/monitors/run-coordinator.ts`; `apps/web/package.json` only if its existing workspace dependency already covers queue access (otherwise defer dependency wiring to 2.1).
  - **Acceptance:** a missing/unusable Redis configuration or client initialization causes an unavailable coordinator outcome, never a process-local admission decision.
  - **Tests:** injected client initialization failure maps to unavailable; no test contacts a real Redis server.

### 1.5 Verify Slice 1 and freeze its review boundary

- [x] Run coordinator-focused unit tests, the relevant existing monitor validation unit tests, TypeScript for touched workspace packages, and `git diff --check`; record actual RED then GREEN evidence in apply-progress.
  - **Dependencies:** 1.1–1.4.
  - **Acceptance:** all scenario assertions above pass; no source changes outside coordinator/dependency/test scope; no Prisma, Docker, DB, BullMQ job, scheduler, or Check Engine transport change.
  - **PR approval:** PR 1 remains within approximately 300–380 changed lines; if the test scope cannot fit coherently, split test-only coverage into a child PR before exceeding 400 lines.

## Slice 2 — Route Handler and Check Engine (PR 2)

### 2.1 Declare the existing workspace Check Engine dependency and server-only handler contracts

- [x] Add `@api-watchdog/check-engine: workspace:*` to `apps/web/package.json`, and create `apps/web/lib/monitors/run.ts` with injected repository, resolver, constrained transport, coordinator, clock, owner-ID, and execution seams.
  - **Dependencies:** Slice 1 merged into the feature chain; no new third-party dependency.
  - **Acceptance:** production factory reuses only the integrated Check Engine and native constrained transport; dependencies are server-only and client code cannot control headers, bodies, credentials, proxies, redirects, TLS, URL, method, timeout, or expected status.
  - **Files:** `apps/web/package.json`, `apps/web/lib/monitors/run.ts`, and `apps/web/lib/monitors/index.ts` only if existing factory exports must be extended without altering CRUD contracts.

### 2.2 Write RED handler and route tests for input validation and project isolation

- [x] Create `tests/unit/manual-run-handler.test.ts` and (where the established route harness supports it) `tests/integration/manual-run-api.test.ts` for invalid CUIDs, non-empty query, any request body, absent monitor, foreign-project monitor, and bodyless valid `ACTIVE`/`PAUSED` monitor requests.
  - **Dependencies:** 2.1.
  - **Acceptance:** invalid request returns `400 INVALID_REQUEST`; absent and foreign are indistinguishable `404 MONITOR_NOT_FOUND`; no coordinator acquisition or engine invocation occurs for rejected requests; PAUSED remains PAUSED.
  - **Spec evidence:** project-scoped execution, client-input rejection, foreign-monitor and absent-monitor scenarios.
  - **RED evidence:** tests fail before request guards and strictly scoped repository lookup exist.

### 2.3 Implement the Node.js Route Handler and persisted-only execution mapping

- [x] Create `apps/web/app/api/projects/[projectId]/monitors/[monitorId]/run/route.ts` with `runtime = "nodejs"` and add the `createManualRunHandlers(...).POST` implementation in `apps/web/lib/monitors/run.ts`.
  - **Dependencies:** 1.1–1.4, 2.1–2.2.
  - **Acceptance:** handler reads decoded params exactly once, rejects query/body before lookup, calls only a project-scoped repository lookup, admits both `ACTIVE` and `PAUSED`, uses only persisted URL/method/expected status/timeout, and adds `Cache-Control: no-store`.
  - **Safety:** an `OPTIONS` value already persisted by older validation is rejected as `500 INTERNAL_ERROR` before resolver/transport invocation; the task must not broaden the Check Engine method contract.
  - **Tests:** make 2.2 cases GREEN; assert persisted monitor state is unchanged and no request starts for `OPTIONS`.

### 2.4 Write RED cancellation, cleanup, and result-contract tests

- [x] Extend `tests/unit/manual-run-handler.test.ts` with failing tests for acquire-before-execute, release in `finally` exactly once on success, typed failure, thrown execution error, engine deadline timeout, and available `request.signal` abort; include late resolver/transport callbacks that cannot produce a second result or release a later owner.
  - **Dependencies:** 2.3.
  - **Acceptance:** client disconnect is modeled as an optional signal, not assumed to terminate the Route Handler; cleanup remains mandatory even when no response is deliverable.
- [x] Add RED serialization cases for every Check Engine outcome, optional `statusCode`, sensitive thrown/Redis data, and stable route errors (`409`, `429`, `503`, `500`).
  - **Dependencies:** 2.3.
  - **Acceptance:** `JSON.stringify` of all public responses contains no URL, query, IP, body, credential, cookie, Redis detail, socket/TLS/DNS detail, or stack trace.

### 2.5 Compose server cancellation with the engine deadline and serialize stable results

- [x] Modify `packages/check-engine/src/types.ts` and `packages/check-engine/src/engine.ts` only to accept a server-internal optional abort signal and compose it with the existing absolute 10-second controller; do not change public monitor inputs, result DTOs, transport options, DNS/SSRF/pinning/TLS/redirect/byte-limit semantics, or deadline behavior.
  - **Dependencies:** 2.4 RED.
  - **Acceptance:** the same composed signal reaches resolver and native transport; external abort never extends/restarts the engine deadline, a late operation cannot alter a settled outcome, and listeners are released.
  - **Tests:** focused Check Engine fake resolver/transport tests prove external abort composition, deadline retention, late callback suppression, and resource cleanup; no external HTTP.
- [x] GREEN: Complete `apps/web/lib/monitors/run.ts` so it invokes the coordinator only after guarded scoped lookup, invokes the Check Engine only after admitted ownership, releases exactly that owner in `finally`, maps all typed engine outcomes to `200` redacted `ManualRunResultDto`, and maps only stable admission/unexpected failures to the specified error codes.
  - **Dependencies:** 1.1–1.4, 2.4, engine cancellation seam.
  - **Acceptance:** Redis unavailable/indeterminate returns `503 RUN_COORDINATION_UNAVAILABLE` with no engine call; no local fallback; request disconnect never starts replacement work or persists output.
  - **Tests:** all 2.4 RED cases pass, including cleanup and redaction.

### 2.6 Verify Slice 2 isolation and API behavior

- [x] Run focused handler, Check Engine cancellation, and route integration tests; run relevant existing monitor CRUD/validation regressions and TypeScript; use only the isolated test database when an existing integration command requires it, never development/production data.
  - **Dependencies:** 2.1–2.5.
  - **Acceptance:** route tests prove other-project IDs cannot acquire Redis state or execute a check; native local fixtures remain the only transport tests; no external HTTP, scheduler, worker, Redis job, history, or alert path is introduced.
  - **PR approval:** PR 2 targets the preceding coordination branch and stays approximately 280–380 changed lines. If the engine cancellation seam and route cannot fit as one coherent slice, split server-only cancellation coverage from the route wiring before implementation.

## Slice 3 — Monitor Detail UI and E2E (PR 3)

### 3.1 Define client-safe Run Now types and write RED client/UI tests

- [x] Modify `apps/web/components/monitors/types.ts` and `tests/unit/monitor-ui.test.ts` to add a project/monitor-scoped bodyless Run Now path builder, narrow transient `ManualRunResultDto`/stable error parser, and RED cases for safe response parsing and encoded project/monitor segments.
  - **Dependencies:** Slice 2 API contract.
  - **Acceptance:** client types expose only `outcome`, `latencyMs`, optional `statusCode`, and stable error code/message; no target, request configuration, transport diagnostic, or persistence field exists.
  - **Tests:** malformed/unknown JSON is an endpoint error, not a fabricated check result; normal project IDs and reserved characters retain exactly one URL encoding.

### 3.2 Implement accessible transient Run Now behavior in Monitor Detail

- [x] Modify `apps/web/components/monitors/monitor-detail.tsx` to add a keyboard-operable Run Now button and a dedicated `runPending`, `runResult`, `runError`, and client `AbortController`, independent from pause/delete busy state.
  - **Dependencies:** 3.1 and Slice 2 API route.
  - **Acceptance:** a pending run disables only duplicate Run Now requests, a 200 typed failure is rendered as a check result rather than an endpoint error, stable 409/429/503/500 errors are rendered separately, results are live-region announced, focus remains usable, and state remains client-only.
  - **Unmount behavior:** abort the fetch on unmount/navigation and discard late state updates; do not assume server work ceases solely because the UI unmounted.
  - **Spec evidence:** loading, success, typed failure, coordination errors, keyboard/live announcement, and no-history scenarios.

### 3.3 Add E2E coverage using intercepted project-scoped responses

- [x] Create `tests/e2e/monitor-run-now.spec.ts` with route interception for success, every representative typed check failure, `RUN_IN_PROGRESS`, `RUN_COOLDOWN`, `PROJECT_CONCURRENCY_LIMIT`, `RUN_COORDINATION_UNAVAILABLE`, and `INTERNAL_ERROR`.
  - **Dependencies:** 3.1–3.2.
  - **Acceptance:** browser tests verify loading/disabled duplicate click behavior, result/status/latency rendering, endpoint-error distinction, project context preservation, keyboard invocation, accessible live feedback, and navigation/unmount without stale UI updates.
  - **Safety:** E2E never contacts a public monitor, creates persistent runs/history, or needs a real Redis coordinator.

### 3.4 Run cross-slice regression and visual/accessibility verification

- [x] Execute focused UI/unit/E2E checks plus the relevant Monitor CRUD, API, Check Engine, TypeScript, and `git diff --check` regressions. Inspect desktop/mobile detail behavior against the approved Monitor Details reference `(read-only) design/openpencil/api-watchdog-dashboard-v1.fig` without modifying OpenPencil.
  - **Dependencies:** 3.1–3.3.
  - **Acceptance:** Run Now remains a minimal addition to the existing Monitor Detail visual system; no historical metrics, scheduler/worker controls, incidents, alerts, auth claims, or new monitor configuration appears.
  - **PR approval:** PR 3 targets the preceding route branch, remains approximately 230–360 changed lines, and includes the accessibility/E2E proof for all user-visible flows.
  - **Authorized exception (2026-11-25):** the exact OpenPencil `.fig` comparison was not performed after two bounded MCP connection attempts failed. Desktop/mobile captures, real-browser Playwright evidence, and maintainer manual UI review are accepted for this task; the deferred `.fig` comparison remains a future visual-refinement item.

## Final Cross-Slice Verification

- [x] Reconcile all 21 specification scenarios against observed test evidence and record actual unavailable checks rather than inventing passes. Confirm the Run Now endpoint has no authentication layer and document that project scoping is isolation, not caller authorization.
  - **Dependencies:** Slices 1–3.
  - **Acceptance:** prove no simultaneous same-monitor checks, fourth project check rejection, 30-second admission-based cooldown, owner-safe expiry/release, Redis fail-closed behavior, cross-project non-execution, transient UI results, and preserved Check Engine security guarantees.
  - **Out of scope guard:** no Prisma migration, database result persistence, scheduler, BullMQ job, worker, Redis queue, incident, alert, notification, external target, Stitch, or OpenPencil change is accepted.
  - **Completion note (2026-11-25):** all functional scenarios have observed unit, isolated Redis/Lua, native transport, real route, and real browser evidence. The only excepted activity is the explicit visual reference comparison recorded in task 3.4; it is not claimed as performed.
