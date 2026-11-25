# Proposal: Manual Monitor Run

## Intent

Allow a user viewing an existing monitor to request one on-demand HTTP check and see its safe, structured outcome immediately. The feature must reuse the integrated HTTP Check Engine rather than create another outbound-request path, while preserving project isolation and avoiding monitoring history, schedules, incidents, or alerts.

## Scope

### In Scope
- Add a project-scoped server endpoint to run one existing monitor configuration through the HTTP Check Engine.
- Add a Run Now interaction and transient result state to the monitor detail screen.
- Enforce project-scoped monitor lookup, bounded concurrent manual execution, rate limiting, and duplicate-run prevention.
- Return and display only the engine's redacted outcome, HTTP status (when available), and latency.
- Add isolated unit, route/integration, and browser-flow coverage without contacting public targets.

### Out of Scope
- Scheduled or queued recurring checks, worker processing, BullMQ jobs, execution history, database persistence of results, incidents, alerts, notifications, and new monitor types.
- User-controlled transport settings, request headers, cookies, credentials, request bodies, proxies, redirects, or TLS options.
- Prisma schema, migration, Docker, and infrastructure changes.

## Capabilities

### New Capabilities
- `manual-monitor-run`: Execute one project-scoped monitor on demand through the secure HTTP Check Engine and return a transient, redacted result to the monitor-detail user interface.

### Modified Capabilities
- None.

## Approach

Implement a Node.js Route Handler for `POST /api/projects/{projectId}/monitors/{monitorId}/run` that loads the monitor with the existing project-scoped repository, creates the production pinned transport, and invokes `executeCheck` with only persisted monitor configuration. A small server-side run coordinator will use Redis-backed, atomically acquired scoped leases to reject a duplicate active run and enforce a bounded manual-run rate policy. It will always release only its own lease in a `finally` path.

The handler returns a stable DTO containing `outcome`, `latencyMs`, and optional `statusCode`; it never returns target URLs, IPs, bodies, DNS/TLS errors, credentials, cookies, or stacks. The monitor detail client adds a disabled-while-running Run Now control and a live result panel for successful and failed typed outcomes. Results remain in client state only for this first scope.

BullMQ is intentionally not used for the first delivery: the user needs a bounded, immediately visible one-off result, whereas a job/worker flow would require job status/result persistence and cross-process result delivery that belong to a later execution-history or scheduler scope. The existing Check Engine absolute deadline bounds the direct request. The design phase must validate host runtime duration constraints and define the coordinator's exact Redis lease/cooldown ownership semantics.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `apps/web/app/api/projects/[projectId]/monitors/[monitorId]/run/route.ts` | New | Node.js project-scoped Run Now Route Handler. |
| `apps/web/lib/monitors/` | Modified/New | Server-side monitor execution service, dependency seams, stable API errors, and Redis lease coordination. |
| `apps/web/components/monitors/monitor-detail.tsx` | Modified | Run Now control, loading/error/result rendering, and accessible live announcements. |
| `apps/web/components/monitors/types.ts` | Modified | Narrow API path and redacted result DTO types. |
| `apps/web/package.json` | Modified | Consume the existing workspace Check Engine package if it is not already declared. |
| `packages/check-engine/` | Reused | Secure resolution, address pinning, TLS, deadline, byte limit, and redacted typed outcomes; no engine behavior changes planned. |
| `tests/unit/`, `tests/integration/`, `tests/e2e/` | Modified/New | Isolated execution, coordination, route, UI, and project-context test coverage. |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Duplicate requests cause overlapping outbound checks | Medium | Atomic Redis lease keyed by project and monitor; return a documented conflict while lease is held; owner-checked cleanup. |
| Manual runs are abused to amplify outbound traffic | Medium | Project/monitor-scoped rate limit plus server-side concurrency cap; use only persisted configurations and the engine's hard limits. |
| Direct request outlives hosting limits | Medium | Keep synchronous execution bounded by the engine deadline; validate deployment/runtime timeout in design and fail safely if incompatible. |
| Sensitive transport details reach the browser or logs | Medium | Serialize only typed outcome, status code, and latency; test JSON redaction and avoid server logging of engine errors. |
| A paused monitor has ambiguous manual-run behavior | Medium | Resolve explicitly in specs before implementation. |

## Rollback Plan

Revert the Run Now route, UI control, and coordinator as one feature slice. This removes the new manual execution path without altering monitor configuration, the Check Engine package, or persisted data because run outcomes are not stored.

## Dependencies

- The merged `@api-watchdog/check-engine` secure execution engine.
- Existing project-scoped monitor repository and Route Handler conventions.
- Existing Redis deployment and the queue package's Redis connection support for bounded coordination.

## Success Criteria

- [ ] A project-scoped monitor detail can request exactly one secure check and render a redacted typed result.
- [ ] A project cannot run a monitor belonging to another project, and absent monitors return the established not-found behavior.
- [ ] Duplicate and rate-limited requests do not start additional engine executions and expose stable, non-sensitive errors.
- [ ] Engine outcomes map without exposing target, body, IP, credentials, cookies, or stack details.
- [ ] Automated unit, integration, and E2E tests cover loading, success, typed failure, isolation, coordination, and keyboard-accessible UI behavior without external network access.
