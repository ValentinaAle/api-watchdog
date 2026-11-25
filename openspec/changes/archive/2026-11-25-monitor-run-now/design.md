# Design: Manual Monitor Run

## Technical Approach

Manual Run adds one project-scoped, synchronous Node.js Route Handler and a narrowly scoped client interaction to the existing monitor detail view. The handler reads only the persisted monitor configuration through the existing project-scoped repository, atomically obtains a Redis-backed admission lease, runs that configuration through `@api-watchdog/check-engine`, releases only its own lease, and serializes a transient redacted result.

The feature deliberately does not introduce a second outbound HTTP implementation. The Check Engine remains the only component that resolves destinations and opens sockets, retaining its address validation, pinned lookup, peer validation, Host/SNI/TLS behavior, terminal redirects, absolute deadline, byte limit, and redacted result model.

The route is synchronous because an immediately visible one-off result is the product objective. A BullMQ job would require durable job state and result delivery, which are explicitly outside this change. The engine's maximum ten-second deadline bounds the direct execution; Redis leases provide cross-request admission safety while the result remains client-local.

## Architecture Decisions

### Decision: Use a Node.js Route Handler with injected server dependencies

**Choice**: Add `POST /api/projects/[projectId]/monitors/[monitorId]/run` with `runtime = "nodejs"`. Its handler factory accepts a project-scoped monitor repository, DNS resolver, constrained transport/Check Engine runner, Redis coordinator, UUID source, and clock/cancellation seams.

**Alternatives considered**: Run Check Engine code directly in the client; call `fetch` from the route; enqueue a BullMQ job and poll it; put all behavior in the existing CRUD action factory.

**Rationale**: Browser execution would expose the target and cannot enforce SSRF protections. A second HTTP client would bypass the proven engine. A queue requires persistence/status machinery that is not in scope. A dedicated handler factory keeps manual execution dependencies explicit while reusing the established monitor API's repository and parameter-validation conventions.

### Decision: Treat both ACTIVE and PAUSED monitor configurations as eligible

**Choice**: The run service accepts a persisted monitor in either `ACTIVE` or `PAUSED` status and never writes monitor status or configuration.

**Alternatives considered**: Permit only `ACTIVE`; resume a paused monitor for a one-off run; mutate a last-run field.

**Rationale**: A paused configuration suppresses scheduled behavior, not an explicit diagnostic action. No scheduler or execution persistence exists in this scope, so mutation would be misleading and unnecessary.

### Decision: Use one Redis Lua admission script and one ownership-checked release script

**Choice**: A Redis coordinator uses `EVAL` scripts as the sole state-transition API. Admission atomically removes expired project entries, checks active monitor lease, checks cooldown, checks project capacity, creates every required state entry, and returns a stable reason. Release atomically removes only the requesting owner from the monitor lease and project set.

**Alternatives considered**: Process-local mutexes; separate GET/SET/INCR calls; a BullMQ limiter; a Redis counter without owner identity; Redlock.

**Rationale**: Local locks do not coordinate Next.js processes. Multi-command checks race. A bare counter cannot safely remove a late owner's contribution. Redlock adds distributed-lock semantics and operational complexity that are unnecessary for a single Redis state authority. Redis executes a Lua script atomically, and owner tokens make delayed cleanup harmless.

#### Key model and constants

All keys are namespaced and use the project identifier only as a Redis key segment; neither key names nor values are returned to clients or logged.

| Purpose | Key / member | Value | Lifetime |
|---|---|---|---|
| Active monitor lease | `manual-run:v1:project:{projectId}:monitor:{monitorId}:active` | opaque UUID owner token | `15_000 ms` |
| Per-monitor cooldown | `manual-run:v1:project:{projectId}:monitor:{monitorId}:cooldown` | opaque UUID owner token | `30_000 ms` |
| Project active set | `manual-run:v1:project:{projectId}:active` | ZSET member = opaque UUID, score = owner expiry epoch ms | key expires after `15_000 ms`, refreshed on successful admission |

`LEASE_TTL_MS` is 15 seconds: the Check Engine has a hard 10-second end-to-end deadline, leaving five seconds for handler scheduling, abort propagation, and owner cleanup. The value is not a second execution deadline; it is crash recovery protection. The cooldown starts at admission and is intentionally independent of the active lease, so it survives a typed failure, cancellation, timeout, or internal execution failure.

#### Admission script contract

The coordinator supplies `nowMs`, `leaseExpiryMs = nowMs + 15_000`, a fresh cryptographically strong owner token, the capacity `3`, and the two TTL constants. The script performs these steps in one Redis transaction:

1. `ZREMRANGEBYSCORE(projectActive, -inf, nowMs)` to remove expired owner contributions.
2. If `monitorActive` exists, return `RUN_IN_PROGRESS` without changing any key.
3. If `cooldown` exists, return `RUN_COOLDOWN` without changing any key.
4. If `ZCARD(projectActive) >= 3`, return `PROJECT_CONCURRENCY_LIMIT` without changing any key.
5. `SET monitorActive owner NX PX 15000`; if that cannot be confirmed, return `RUN_COORDINATION_UNAVAILABLE` and do not execute.
6. `SET cooldown owner NX PX 30000`, `ZADD projectActive leaseExpiryMs owner`, and `PEXPIRE projectActive 15000`.
7. Return `ADMITTED` with the owner token retained only by the server invocation.

The script treats any Redis command/transport error, malformed reply, or impossible partial reply as indeterminate. The coordinator maps it to `RUN_COORDINATION_UNAVAILABLE`; the route returns 503 and never invokes the engine. There is no process-local fallback.

#### Release script contract

The release script receives the same project/monitor keys and the owner token. It deletes `monitorActive` only when `GET monitorActive == owner`, then performs `ZREM projectActive owner` regardless of the monitor key's current value. It returns an idempotent completion indicator, not a client-visible execution result.

Owner tokens are generated anew for every admission and never reused. Consequently, a prior owner whose TTL expired cannot delete a successor's monitor key (the token differs) and cannot decrement a successor's ZSET member (the member differs). If release itself cannot reach Redis after admission, the handler records no sensitive error and relies on the finite lease expiry; it does not start replacement work, retry admission locally, or expose Redis details.

### Decision: Compose request cancellation with the Check Engine deadline

**Choice**: Extend the engine dependency seam with an optional server-supplied abort signal (not monitor input and not a public result field). `executeCheck` composes that signal with its existing controller/deadline so the same composed signal reaches DNS resolution and the native transport. The engine's own maximum deadline stays authoritative.

**Alternatives considered**: Depend on Route Handler response cancellation implicitly; create a second timer in the route; cancel only after a response write; leave client disconnects to the transport.

**Rationale**: A Next.js Route Handler is not guaranteed to be terminated merely because its HTTP client disconnects. Explicit signal forwarding is the only testable way to request early cancellation. The engine already handles one absolute deadline across DNS and transport, so composition preserves rather than replaces its security properties.

The route listens to `request.signal` only while its execution is in flight. If it aborts, the route aborts the composed signal. If a response is still deliverable, normal engine cancellation mapping remains a typed outcome; if the client is gone, the route does not attempt to synthesize or persist a result. In all cases its `finally` attempts owner-checked release exactly once. If the process dies, no finally path is guaranteed; the 15-second monitor lease and expired-score pruning restore capacity safely.

### Decision: Stable redacted DTO and stable admission errors

**Choice**: The successful endpoint response is exactly:

```ts
type ManualRunResultDto = {
  outcome:
    | "success"
    | "unexpected_status"
    | "dns_failure"
    | "connection_failure"
    | "tls_or_protocol_failure"
    | "timeout"
    | "response_limit";
  latencyMs: number;
  statusCode?: number;
};
```

The only route errors are stable `{ error: { code, message } }` values:

| Condition | HTTP | Code |
|---|---:|---|
| Invalid CUID, query/body, or client execution input | 400 | `INVALID_REQUEST` |
| Monitor absent or outside requested project | 404 | `MONITOR_NOT_FOUND` |
| Same monitor has an active lease | 409 | `RUN_IN_PROGRESS` |
| Its cooldown remains | 429 | `RUN_COOLDOWN` |
| Project has three active runs | 429 | `PROJECT_CONCURRENCY_LIMIT` |
| Redis unavailable/indeterminate at admission | 503 | `RUN_COORDINATION_UNAVAILABLE` |
| Unexpected server-only failure | 500 | `INTERNAL_ERROR` |

**Alternatives considered**: Return raw engine errors; map typed check outcomes to 4xx/5xx; persist a run record and return an identifier.

**Rationale**: Typed engine outcomes describe a completed check, including failure, and are not endpoint failures. A narrow DTO prevents URL, query, IP, body, DNS/TLS/socket error, credential, cookie, Redis detail, and stack disclosure. Persistence and a job identifier would expand the product into history/status tracking.

### Decision: Keep Run Now UI state local and independently busy

**Choice**: Add a Run Now button and small live result region to `MonitorDetail`. Use a dedicated `runPending`, `runResult`, `runError`, and client-owned `AbortController`, separate from existing pause/delete `busy` state. Abort the client fetch on unmount/navigation, and discard late client state updates.

**Alternatives considered**: Add result state to the monitor model; reuse pause/delete busy state; add historical cards/charts; fire-and-forget run requests.

**Rationale**: The feature must not create run history or conflate independent controls. Local state naturally clears on refresh/navigation and makes duplicate clicks impossible while a request is pending. The view can distinguish a 200 typed check result (including a failing outcome) from a stable endpoint/admission error without inventing telemetry.

## Data Flow

```text
MonitorDetail (client)
  POST /api/projects/{projectId}/monitors/{monitorId}/run (bodyless)
       |
       v
Route Handler (Node.js)
  validate path + no body/query
  repository.get(projectId, monitorId)
       |                        \-- missing/foreign -> 404
       v
ManualRunCoordinator.acquire(projectId, monitorId, owner)
       |                        \-- stable admission rejection -> 409/429/503
       v
executeCheck(persisted config, { resolver, native transport, signal })
       |
       +--> secure DNS -> pinned HTTP(S) -> typed redacted CheckResult
       |
       v
ManualRunCoordinator.release(owner) in finally
       |
       v
ManualRunResultDto (transient 200) -> accessible client result panel
```

The route never accepts target/method/timeout/status/transport data from the client. The server maps the monitor database record to `CheckInput` (`url`, method restricted to the engine's six persisted methods, `timeoutMs`, `expectedStatus`) only after isolation and admission. Existing monitor creation may persist `OPTIONS`, while the Check Engine intentionally supports only the six methods declared in its contract; a persisted unsupported method is treated as a generic server configuration failure (`INTERNAL_ERROR`) without an outbound attempt and is covered by a regression test. This preserves the engine contract instead of silently broadening it.

## File Changes

| File | Action | Description |
|---|---|---|
| `apps/web/app/api/projects/[projectId]/monitors/[monitorId]/run/route.ts` | Create | Node.js `POST` adapter forwarding the Request and decoded route params to the manual-run handlers. |
| `apps/web/lib/monitors/run.ts` | Create | Route/service factory, input guards, scoped lookup, Check Engine mapping, stable response serialization, signal wiring, and owner-finally cleanup. |
| `apps/web/lib/monitors/run-coordinator.ts` | Create | Redis Lua admission/release scripts, opaque owner generation seam, TTL constants, stable admission result mapping, and injected Redis command interface. |
| `apps/web/lib/monitors/http.ts` | Modify | Reuse or expose narrow monitor/repository/path/error helpers required by the run handler without changing CRUD behavior. |
| `apps/web/lib/monitors/index.ts` | Modify | Add `run` to the monitor API factory while retaining existing collection/item/action contracts. |
| `apps/web/components/monitors/types.ts` | Modify | Add the project/monitor-scoped Run Now API path, DTO/error types, and safe client response parser. |
| `apps/web/components/monitors/monitor-detail.tsx` | Modify | Add keyboard-operable Run Now interaction, independent pending state, live announcements, transient result/error rendering, and unmount abort. |
| `apps/web/package.json` | Modify | Declare the existing workspace dependency `@api-watchdog/check-engine`; no new third-party package. |
| `packages/check-engine/src/types.ts` | Modify | Add only a server-internal optional abort dependency seam required to compose client cancellation with the existing deadline. |
| `packages/check-engine/src/engine.ts` | Modify | Compose external cancellation with the existing absolute deadline without changing result DTOs, transport options, or security semantics. |
| `tests/unit/manual-run-coordinator.test.ts` | Create | Deterministic atomic-admission, ownership, expiry, cooldown, capacity, and unavailable-Redis tests using an injected script-client model. |
| `tests/unit/manual-run-handler.test.ts` | Create | Isolated handler tests with repository/engine/coordinator/clock/signal doubles, including all stable result and error mappings/redaction. |
| `tests/unit/monitor-ui.test.ts` | Modify | Add Run Now path and result-format helper coverage. |
| `tests/integration/manual-run-api.test.ts` | Create | Project-scoped Route Handler integration using test database only when existing integration harness is available; no external HTTP or Redis. |
| `tests/integration/http-check-native-transport.test.ts` | Modify only if needed | Add no new Run Now behavior; remains a regression suite for the reused transport. |
| `tests/e2e/monitor-run-now.spec.ts` | Create | Browser flow using route interception for results/errors, project-context preservation, keyboard, live status, loading, and unmount behavior. |

The existing `packages/queue` package remains the source of `createRedisConnection`; this change does not create a BullMQ queue or job. A process-scoped cached Redis client is created only in the server coordinator default dependency path and is never instantiated by injected unit tests.

## Interfaces / Contracts

```ts
type ManualRunCoordinator = {
  acquire(input: {
    projectId: string;
    monitorId: string;
    ownerId: string;
    nowMs: number;
  }): Promise<
    | { kind: "admitted"; ownerId: string }
    | { kind: "rejected"; code: "RUN_IN_PROGRESS" | "RUN_COOLDOWN" | "PROJECT_CONCURRENCY_LIMIT" }
    | { kind: "unavailable" }
  >;
  release(input: { projectId: string; monitorId: string; ownerId: string }): Promise<void>;
};

type ManualRunDependencies = {
  repository: Pick<MonitorRepository, "get">;
  resolver: MonitorDnsResolver;
  transport: ConstrainedTransport;
  coordinator: ManualRunCoordinator;
  execute: typeof executeCheck;
  createOwnerId(): string;
  now(): number;
};
```

`createManualRunHandlers(dependencies?)` returns a `POST(request, params)` handler. It first rejects an invalid CUID, a nonempty URL query, or any body stream before lookup. It calls `repository.get(projectId, monitorId)`, not a global monitor lookup, so foreign and absent monitors remain indistinguishable and do not create Redis state.

The production dependency factory uses the existing monitor repository and resolver, `createNativeHttpTransport()`, the secure `executeCheck`, and a Redis coordinator built from validated server environment configuration. Test factories never create a Redis client or native network transport unless a local fixture deliberately supplies one.

The API route responds with `Cache-Control: no-store`. It accepts no request JSON and does not log raw caught errors. Internal diagnostics, if operational logging exists later, may log a stable category/owner-independent correlation identifier only; they must never log engine errors, URL, address, query, headers, body, credentials, cookies, or Redis command details.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit: coordinator | Lua request shapes and atomic outcomes; concurrent same-monitor attempts; exactly three project owners; 29,999/30,000ms cooldown boundary; TTL expiry; old-owner release after successor; unavailable/malformed Redis replies | Inject a deterministic Redis-script adapter that serializes `eval` calls. Start actual concurrent `Promise.all` admissions behind a barrier, not hand-sequenced calls. Assert only one winner and no rejected state mutation. |
| Unit: handler | Valid bodyless POST for ACTIVE and PAUSED; invalid IDs/query/body; scoped missing/foreign; each Check Engine outcome; unsupported persisted method; stable errors and JSON redaction; cleanup in success, typed failure, throw, timeout, and abort | Inject repository, coordinator, runner, owner, clock, and abort-capable transport. Assert engine receives only persisted fields and cleanup is owner-only/exactly once. |
| Unit: Check Engine | External abort composition, deadline retention, late resolver/transport events, no second result | Extend existing isolated fake resolver/transport tests; no network. |
| Integration: route | Route module delegates Node runtime to handler; project isolation; no body; response status/DTO/header; coordinator-error mapping | Use existing isolated monitor API test conventions. Use injected dependencies and the test database only where needed; do not need live Redis or a public target. |
| Integration: Redis contract | Script command keys/arguments, owner token isolation, and atomic failure mapping | Contract-test the injected script client with concurrent callers; a real external Redis instance is not required by normal tests. A future infrastructure smoke check may run against an explicitly provisioned disposable Redis, but it is not a test prerequisite. |
| E2E | Detail Run Now loading, disabled duplicate prevention, success/typed failure rendering, admission error recovery, encoded project route, keyboard activation/focus/live announcement, navigation unmount | Playwright intercepts only the new project-scoped API response. It never contacts a public target, creates history, or needs Redis. |

Tests distinguish actual concurrent promises from sequential setup. The coordinator's script-client fake must model a single Redis script execution boundary and intentionally exercise rejected calls concurrently; this demonstrates the application-level race behavior while keeping the suite independent of external Redis. Tests that must prove native Check Engine transport behavior remain in the pre-existing loopback-only transport suite.

## Threat Matrix

| Boundary | Applicability | Design response | Planned RED tests |
|---|---|---|---|
| Documentation-like paths | N/A — this change neither classifies nor executes repository files. | None. | None. |
| Git repository selection | N/A — no Git command or repository selection is added. | None. | None. |
| Commit state | N/A — no commit automation is added. | None. | None. |
| Push state | N/A — no remote publishing operation is added. | None. | None. |
| PR commands | N/A — no PR automation is added. | None. | None. |

The Route Handler is an HTTP route, not a shell/process-routing boundary. Its security boundary is covered instead by the explicit request guards, project-scoped lookup, Redis coordinator, and preserved Check Engine guarantees above.

## Migration / Rollout

No database migration, Prisma migration, queue/job, Docker, or infrastructure change is required. The deployment already supplies `REDIS_URL`; the new route validates that server configuration at use time. Redis unavailability fails closed with 503 rather than falling back locally.

Rollout consists of shipping the handler and UI together after their dependencies. Rollback removes the route/UI/coordinator imports as one feature without touching monitor configuration, data, or the Check Engine. In-flight requests remain bounded by the engine deadline; Redis lease expiry cleans state if the process terminates during rollback.

## Delivery Plan

The work should use a feature-branch chain so each slice has an independently reviewable diff. The final `sdd-tasks` phase will refine estimates against the exact code state.

1. **PR1 — server contracts and coordination (estimated 300–380 lines):** add the Redis coordinator, deterministic unit tests for atomic admission/ownership/cooldown/capacity, and the minimal workspace dependency wiring. This slice introduces no public route or UI.
2. **PR2 — secure Run Now route (estimated 280–380 lines):** add composed server cancellation to the Check Engine, the run handler/route, injected route tests, scoped lookup, body/query validation, and redacted result/error mapping. It depends on PR1.
3. **PR3 — monitor detail interaction (estimated 230–360 lines):** add client API helpers, accessible transient UI behavior, focused UI/E2E interception tests, and project-context navigation coverage. It depends on PR2.

Each PR must run its focused checks before the next slice. No PR includes scheduler, BullMQ job processing, persistent history, incidents, alerts, or user-authentication work.

## Risks and Accepted Constraints

- **No authentication exists.** Project scoping prevents cross-project monitor lookup through the route but does not identify or authorize a caller. The endpoint is therefore an exposure risk until the product adds authentication; this change documents it and does not claim to solve it.
- **Redis release can fail after a run has started.** The handler cannot undo an already-authorized outbound check. It makes best-effort owner release, relies on the finite 15-second lease, and exposes neither Redis details nor a local fallback.
- **Client disconnect delivery varies by hosting runtime.** The route forwards `request.signal` when available but never assumes disconnect automatically cancels work; engine deadline and finally cleanup remain mandatory.
- **Persisted OPTIONS monitors are incompatible with the merged engine method contract.** The route fails safely without a network attempt. Aligning validation/model method domains is a separate, explicit scope decision; this design does not silently add OPTIONS support.

## Open Questions

None. The Redis scripts, lease/cooldown values, cancellation seam, and delivery slices are fully specified for task planning.
