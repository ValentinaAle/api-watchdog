# Apply Progress: Project-Scoped Monitor Management

## Batch

- Change: `monitor-crud`
- Assigned scope: Phase 3, tasks 3.1–3.4 (IPv4/IPv6 destination classification and injected asynchronous DNS admission).
- Mode: Standard (`strict_tdd: false`); observed RED → GREEN was performed as requested for both tasks.
- Delivery: `stacked-to-main`, PR 3 scope (SSRF destination classification and DNS admission); no commit, PR, push, or merge was performed.
- Prior apply progress: merged completed tasks 1.1–1.3 and their evidence from Engram observation #13 (`sdd/monitor-crud/apply-progress`).

## Task Status

- [x] 1.1 RED database contract tests and isolated integration harness — expected RED observed before implementation; after GREEN, all 5 focused integration tests passed against the isolated test database.
- [x] 1.2 Additive Prisma Monitor schema and migration — enums, required Project relation, 100-character name bound, restrictive FK, collection index; generated Prisma Client and applied the additive migration to `DATABASE_URL_TEST` only.
- [x] 1.3 Project-scoped repository and export — project-scoped create/list/get/update/delete; compound projectId + monitor ID predicates and deterministic newest-first ordering; focused integration suite passed 5/5.
- [x] 2.1 RED — added 53 focused schema/URL tests (including the existing root unit test in the command count); before implementation, 48 new cases failed because schema exports were absent, as expected.
- [x] 2.2 Shared validation schemas — exported strict create/update schemas and normalized URL schema. Create requires name/url/method/interval/timeout/expectedStatus/status; PATCH is nonempty, partial, strict, and excludes status. URL syntax allows HTTP(S) with a DNS-style hostname, rejects credentials/fragments/special-use host syntax, and returns WHATWG-normalized URLs while allowing canonical dotted-decimal IPv4 and syntactically valid IPv6 literals for later address-classification tasks; rejects shorthand, leading-zero, hexadecimal, and out-of-range IPv4 spellings. No DNS resolver or IP-range classifier is implemented in this slice.
- [x] 3.1 RED literal address and hostname classification tests — 41 new classifier cases failed before the classifier export existed; expanded URL syntax tests reject additional internal/special names.
- [x] 3.2 IPv4/IPv6 allow/deny classification and literal-IP admission — explicit tables reject prohibited/reserved address ranges and malformed values; only public unicast literals are admitted, with generic safe errors.
- [x] 3.3 RED DNS admission tests — deterministic injected A/AAAA resolver tests failed before DNS admission was implemented; cover safe public answers, any unsafe/malformed answer, no answers, resolver failures, timeout, query-string independence, and no HTTP fetch.
- [x] 3.4 Async DNS admission — exported async validation accepts only safe DNS answer sets, requests both families, times out and fails closed, and never uses HTTP.
- [x] 4.1–4.3 API handlers and API tests — PR A collection APIs are merged; PR B adds project-scoped item GET/PATCH/DELETE, pause/resume actions, full API composition, and the remaining integration coverage. The extraction preserves the previously verified 10 integration cases; no database test was rerun for PR B.
- [x] 5.1–5.3 Project-scoped monitor list, create/edit form, detail, pause/resume, and confirmed hard-delete UI — PR A provides list and form; PR B adds API-backed details/actions/delete confirmation. All operations use route `projectId` and the shipped APIs; no fake data, project chooser/default/creation, execution, or telemetry added.
- [ ] 6.1–6.2 E2E and final proof

## UI PR A Batch

- Scope: project-scoped list, create/edit form, shared UI API helpers/types, and focused helper tests; direct `projectId` route context, using API handlers shipped with prior API work.
- Mode: Standard (`strict_tdd: false`).
- Design: mobile-first, dark navy surface/cyan accent/compact technical cards from the retrieved Stitch screens; unsupported telemetry and actions are not included. Detailed UI design/spec notes are intentionally not part of these progress-only PR slices.
- Routes in PR A: `/projects/[projectId]/monitors`, `/new`, `/[monitorId]/edit`.
- API semantics: collection GET/POST and item GET/PATCH; PATCH never changes status. No fake monitor data, project chooser/default/creation, target execution, or telemetry added.
- No seed/project lifecycle convention exists in this checkout. Runtime/E2E requires an existing project plus a working database; none was available, so no fake fixture was added.
- Rollback boundary: revert PR A routes, `apps/web/components/monitors/monitor-list.tsx`, `monitor-form.tsx`, `types.ts`, the palette update in `apps/web/app/globals.css`, `tests/unit/monitor-ui.test.ts`, and this progress section.
- Focused proof: `./node_modules/.bin/vitest run tests/unit/monitor-ui.test.ts` — passed (1 file, 2 tests).
- Full unit suite: `./node_modules/.bin/vitest run` — incomplete; the new UI helper suite passed (2 tests), but the pre-existing validation suites could not load `zod` because dependencies were not installed in this worktree.
- Web typecheck: `./node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json` — blocked by absent `next`, workspace package links, and `zod` in available node_modules; no reliable UI type verdict. Offline install was attempted and stopped because `next@16.4.5` is not in the local package store; network install was not attempted.
- Runtime/e2e proof: not run; no installed Next runtime/dependencies or pre-existing project seed/database fixture was available. Project convention discovery found no seed or project-creation flow, so no fake project/monitor data was added.
- Diff hygiene: `git diff --cached --check` passed before commit; explicit trailing-whitespace scan of new UI and OpenSpec files found none. No browser/runtime proof is claimed.
- Slice size: PR A is independently scoped to list/create/edit and helpers; the detail/actions/delete confirmation follow-up remains a separate slice.
- Commit: created after staging and reviewing this PR A diff; no push, PR, or merge was performed.

## UI PR B Batch

- Scope: project-scoped monitor detail, persisted pause/resume controls, explicit hard-delete confirmation, and focused action-path helper coverage; relies on list/form and API helpers merged by PR A.
- Routes: `/projects/[projectId]/monitors/[monitorId]`; list, create, and edit routes remain supplied by PR A and are not duplicated here.
- Data source: item details/status from the real `GET` and action API envelopes; pause/resume use the shipped dedicated POST endpoints. Delete navigates away only after HTTP 204. Failed actions preserve the existing displayed status.
- UI excludes unsupported health/telemetry/history/incidents/regions, target execution, and mock monitor records.
- Focused UI helper test: `./node_modules/.bin/vitest run tests/unit/monitor-ui.test.ts` — passed (1 file, 3 tests, including project-scoped pause/resume paths). Per parent instruction, unavailable broader checks were not rerun.
- Runtime/e2e remains pending because the environment has no installed Next dependencies or project/database fixture. No browser proof is claimed.
- Diff hygiene: `git diff --cached --check` run before commit.
- Commit: created locally; no push, PR, or merge performed.

## Work Unit Evidence

| Evidence | Result |
|---|---|
| Safety baseline | `pnpm test -- tests/unit/monitor-validation.test.ts` before changes — 59 tests passed across 2 files. |
| 3.1 RED/GREEN | RED: `pnpm test -- tests/unit/monitor-validation.test.ts` — 41 new classifier cases failed because `classifyMonitorAddress` did not exist. GREEN after classifier and hostname cases: 103 passed across 2 files. |
| 3.2 RED/GREEN | RED: same command — 9 literal-admission cases failed because `admitMonitorTarget` did not exist. GREEN after literal admission: 112 passed across 2 files. |
| 3.3 RED/GREEN | RED: same command — 4 DNS behaviors failed because domains returned `TARGET_UNVERIFIABLE` instead of classifying injected A/AAAA results. GREEN after resolver admission and additional single-family cases: 123 passed across 2 files. |
| No-network evidence | Resolver calls are injected mocks only; tests use reserved test hostnames without resolving externally. A stubbed `fetch` spy remained uncalled. Implementation contains no target HTTP client or queue import. No DNS/HTTP request was made to an external target. |
| Lint/type check | `pnpm lint` — passed across apps/web, monitor-worker, and scheduler. Direct validation-package check `pnpm exec tsc --noEmit --target ES2022 --moduleResolution Bundler --module ESNext --strict --skipLibCheck --types node packages/validation/src/monitor.ts packages/validation/src/index.ts` — passed. |
| Build | `pnpm build` — database and worker/scheduler builds completed; Next.js build was blocked by sandbox `Operation not permitted` while Turbopack tried to spawn a process/bind a port to compile `globals.css`; no source error was reported. |
| Diff hygiene | `git diff --check` — passed. |
| Authored diff | Approximately 370 additions + deletions for this Phase 3 slice, excluding pre-existing Phase 2 work; below the ~400-line heuristic, with no test or documentation compression. |
| Runtime harness | N/A — validation/admission only; no runtime transport or persistence boundary is added. |
| Rollback boundary | Revert `packages/validation/src/monitor.ts`, admission/classifier exports in `packages/validation/src/index.ts`, and the SSRF test additions in `tests/unit/monitor-validation.test.ts`; earlier schema/persistence slices remain independently revertible. |

## Approved Decisions Recorded

- PATCH rejects `status`; only the dedicated future `/pause` and `/resume` actions may change it.
- Future UI route is directly project-scoped at `/projects/{projectId}/monitors` and uses an existing/seeded project; no UI, seed data, or project lifecycle work is part of this slice.

## Blocker and Next Step

Tasks 1.1–3.4 and 5.1–5.3 are complete. API tasks are complete per the prior API work and its recorded verification. UI task 6.1–6.2 remains pending: runtime/e2e checks could not run in the unavailable Next/database environment. PR A is merged as `cfcb068`; PR B is locally committed but not published. No worker, scheduler, queue, or target HTTP request was added. The future worker contract still requires validating and pinning every connection and redirect hop, disabling automatic redirects, preventing DNS rebinding, and treating creation admission as no connection permit.

## Commit and Diff

- PR A merged in `cfcb068`; PR B commit recorded in the final task handoff.
- PR/push/merge: none.

## Current API Work — PR B item/action slice

- PR A collection behavior is present in `origin/main` at `848b9ff`. PR B restores only the item CRUD and pause/resume handlers/routes, final `createMonitorApi`/`monitorApi` composition, collection-route dispatch through the completed composition, and corresponding item/action integration cases from the preserved candidate.
- Item operations use project-scoped repository access; PATCH remains configuration-only and performs async target admission only when URL changes; status transitions remain on pause/resume; DELETE is hard delete; actions are idempotent. No target HTTP request or scheduling work is introduced.
- Verification inherited from the complete pre-split candidate: parent-confirmed isolated integration run against the test PostgreSQL — 2 test files, 10 tests passed. The extracted PR B retains those API scenarios, so no database integration test was rerun. Post-extraction checks: `./node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json` passed; `./node_modules/.bin/tsc --noEmit --target ES2022 --moduleResolution Bundler --module ESNext --strict --skipLibCheck --types node --allowImportingTsExtensions tests/integration/monitor-api-items.test.ts` passed; `git diff --cached --check` passed. `pnpm exec` was unavailable because it tried to install into a linked workspace `node_modules` and the registry was unreachable.
- No commit, push, PR, or merge was performed. PR B staging is limited to its source/routes/test and this tracked progress file; historical untracked design/spec/task artifacts are excluded.

## PR B Recovery

The recovery snapshot at `/private/tmp/api-watchdog-monitor-crud-pr-b-recovery` was used to selectively restore the planned PR-B source and test hunks after PR A merged. The snapshot remains available, but no further recovery is pending.
