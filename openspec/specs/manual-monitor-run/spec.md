# Manual Monitor Run Specification

## Purpose

This specification defines a one-off, project-scoped execution of an existing HTTP monitor initiated from its detail view. The execution uses only the persisted monitor configuration and the existing secure HTTP Check Engine. Its result is transient: it is returned to the requesting user interface and is not stored as monitoring history.

## Requirements

### Requirement: Project-Scoped Manual Execution API

The system MUST expose a Node.js server endpoint at `POST /api/projects/{projectId}/monitors/{monitorId}/run`. The endpoint MUST validate both path parameters, MUST accept no client-selected execution input, and MUST execute only the persisted configuration of a monitor that belongs to the specified project. The endpoint MUST permit a manual run for monitors in either `ACTIVE` or `PAUSED` configuration state; a manual run MUST NOT change that configuration state.

The endpoint MUST use the existing HTTP Check Engine as the sole outbound-check mechanism. It MUST NOT introduce a second HTTP client, scheduler, worker, queue job, or user-controlled request transport option. It MUST run in the Node.js runtime and MUST apply the engine's existing secure destination resolution, address pinning, peer verification, TLS/SNI handling, redirect policy, absolute deadline, and response-size limits unchanged.

A request body, client-selected URL, method, timeout, expected status, headers, cookies, credentials, request body, proxy, redirect, or TLS option MUST be rejected with the stable `INVALID_REQUEST` error and MUST NOT start a check.

#### Scenario: An active monitor is run using persisted configuration

- GIVEN project `P` owns an `ACTIVE` monitor `M`
- WHEN the user sends a valid bodyless `POST` request for `P` and `M`
- THEN the system MUST invoke the Check Engine using only `M`'s persisted URL, method, expected status, and timeout
- AND the response MUST contain only the stable redacted run-result DTO
- AND `M`'s persisted configuration and status MUST remain unchanged.

#### Scenario: A paused monitor is manually run

- GIVEN project `P` owns a `PAUSED` monitor `M`
- WHEN the user sends a valid bodyless `POST` request for `P` and `M`
- THEN the system MUST admit and execute the one-off check subject to coordination limits
- AND `M` MUST remain `PAUSED` after the request completes.

#### Scenario: Client input attempts to control execution

- GIVEN project `P` owns monitor `M`
- WHEN a request contains a body or attempts to supply transport or monitor configuration
- THEN the system MUST return `400` with error code `INVALID_REQUEST`
- AND the Check Engine MUST NOT be invoked.

### Requirement: Project Isolation and Not-Found Semantics

The system MUST load a monitor through a lookup scoped to the requested `projectId`. A monitor that does not exist and a monitor that belongs to a different project MUST be externally indistinguishable. Both cases MUST return `404` with the stable error code `MONITOR_NOT_FOUND`, MUST NOT acquire coordination state, and MUST NOT invoke the Check Engine.

This requirement preserves data isolation only. The current product has no authentication or authorization layer; this feature MUST NOT claim to add one or infer a caller identity.

#### Scenario: Monitor belongs to a different project

- GIVEN monitor `M` belongs to project `Q`, not project `P`
- WHEN a caller requests a run under `P` and `M`
- THEN the system MUST return `404` with `MONITOR_NOT_FOUND`
- AND the response MUST be indistinguishable from an absent monitor response
- AND no execution or Redis coordination attempt for `M` MUST start.

#### Scenario: Monitor does not exist

- GIVEN no monitor has identifier `M`
- WHEN a caller requests a run under project `P`
- THEN the system MUST return `404` with `MONITOR_NOT_FOUND`
- AND the Check Engine MUST NOT be invoked.

### Requirement: Stable Redacted Result Contract

When execution is admitted and the Check Engine finishes, the endpoint MUST return `200` with a stable DTO containing `outcome`, `latencyMs`, and `statusCode` only when the engine made an HTTP response status available. The `outcome` MUST be one of the engine's typed outcomes: `success`, `unexpected_status`, `dns_failure`, `connection_failure`, `tls_or_protocol_failure`, `timeout`, or `response_limit`.

All typed Check Engine outcomes, including `timeout`, MUST be represented as an execution result rather than converted into a generic endpoint failure. The DTO and any endpoint error response MUST NOT expose a target URL, query string, IP address, response body, request body, credential, cookie, stack trace, raw DNS/TLS/socket error, Redis detail, or internal implementation detail.

Unexpected handler failures MUST return a stable `500` error code `INTERNAL_ERROR` with a generic message and no internal error detail.

#### Scenario: Check succeeds

- GIVEN a manual run is admitted and the engine returns `success` with a status and latency
- WHEN the endpoint serializes the result
- THEN it MUST return `200` with `outcome: "success"`, the measured `latencyMs`, and that `statusCode`
- AND it MUST NOT include target or transport details.

#### Scenario: Check returns a typed failure outcome

- GIVEN a manual run is admitted and the engine returns any of `unexpected_status`, `dns_failure`, `connection_failure`, `tls_or_protocol_failure`, `timeout`, or `response_limit`
- WHEN the endpoint serializes the result
- THEN it MUST return `200` with that exact `outcome`
- AND it MUST include `statusCode` only when supplied by the engine
- AND it MUST NOT convert the typed outcome into `INTERNAL_ERROR`.

#### Scenario: A sensitive internal error occurs

- GIVEN execution or coordination raises an error containing a URL, query, IP, credentials, cookies, body, or stack trace
- WHEN the endpoint responds or records an operational message
- THEN neither the JSON response nor application logging for this feature MUST contain those sensitive values
- AND a client-visible unexpected failure MUST use only `INTERNAL_ERROR` and a generic message.

### Requirement: Atomic Manual-Run Admission and Ownership

Before invoking the Check Engine, the system MUST atomically coordinate admission in Redis for the validated project-monitor pair. One admitted execution MUST own a unique execution identifier and a per-monitor active lease. While that lease is active, another request for the same project-monitor pair MUST receive `409` with `RUN_IN_PROGRESS` and MUST NOT invoke the Check Engine.

The coordinator MUST atomically enforce all applicable admission rules together; it MUST NOT admit an execution after separately checking a stale duplicate, cooldown, or project count. Each active lease MUST have a finite TTL so a crashed owner cannot block future work indefinitely. The TTL MUST be compatible with the bounded engine execution deadline and handler cleanup period; the exact TTL value is a design decision, but it MUST NOT be shorter than the maximum supported in-flight execution period.

The coordinator MUST record a 30-second per-monitor cooldown at successful admission, not at successful completion. Until the cooldown expires, a request that is not already rejected as an active duplicate MUST receive `429` with `RUN_COOLDOWN` and MUST NOT invoke the Check Engine. The cooldown MUST apply regardless of whether the prior admitted execution later succeeds, returns a typed failure, times out, is cancelled, or encounters an internal execution failure.

Only the owner identified by the unique execution identifier MAY release its active lease or decrement its project concurrency contribution. Release MUST be idempotent. An expired lease, delayed cleanup, or late executor MUST NOT remove or decrement coordination state owned by a later execution. Failed, partial, or indeterminate Redis coordination operations MUST fail closed with `503` and `RUN_COORDINATION_UNAVAILABLE`, MUST NOT invoke the Check Engine, and MUST NOT fall back to process-local coordination.

#### Scenario: Concurrent requests target the same monitor

- GIVEN project `P` owns monitor `M` and no run is active
- WHEN two valid requests for `P` and `M` arrive concurrently
- THEN exactly one request MUST acquire the monitor lease and invoke the Check Engine
- AND the other request MUST return `409` with `RUN_IN_PROGRESS`
- AND the rejected request MUST not invoke the Check Engine.

#### Scenario: Cooldown begins on admission and survives a failed check

- GIVEN a request for project `P` and monitor `M` is admitted
- WHEN the admitted engine execution returns any typed outcome, is cancelled, or fails internally and its active lease is released
- THEN a further request for `P` and `M` before 30 seconds have elapsed MUST return `429` with `RUN_COOLDOWN`
- AND a request at or after cooldown expiry MAY compete for admission.

#### Scenario: Lease owner cleanup cannot release a successor

- GIVEN an execution with owner `A` has expired or finished late and a later execution with owner `B` has acquired the same logical monitor lease
- WHEN owner `A` performs delayed cleanup
- THEN the coordinator MUST preserve owner `B`'s lease and project concurrency contribution
- AND owner `A`'s cleanup MUST have no effect beyond its own ownership.

#### Scenario: Redis coordination is unavailable or partially fails

- GIVEN Redis cannot atomically establish or verify admission state, or a coordination operation returns an indeterminate failure
- WHEN a valid run request arrives
- THEN the system MUST return `503` with `RUN_COORDINATION_UNAVAILABLE`
- AND it MUST NOT invoke the Check Engine
- AND it MUST NOT substitute in-memory locking or rate limiting.

### Requirement: Project Concurrency Limit

The system MUST allow at most three active admitted manual runs for a single project across all its monitors. A request that would become a fourth active project run MUST receive `429` with `PROJECT_CONCURRENCY_LIMIT` and MUST NOT invoke the Check Engine. Rejection for project capacity MUST NOT create an active monitor lease, cooldown, or project count contribution.

#### Scenario: Three project runs are active

- GIVEN project `P` has three active admitted runs for distinct monitors
- WHEN a valid request for a fourth monitor in `P` arrives
- THEN the system MUST return `429` with `PROJECT_CONCURRENCY_LIMIT`
- AND it MUST NOT invoke the Check Engine or create coordination state for that request.

#### Scenario: Capacity is released by the owning execution

- GIVEN project `P` has three active admitted runs and one owner completes, times out, or cancels
- WHEN that owner performs its idempotent ownership-checked cleanup
- THEN the project's active contribution for that owner MUST be released exactly once
- AND a later eligible request MAY be admitted subject to its monitor's own cooldown and all other rules.

### Requirement: Bounded Execution and Cancellation

The handler MUST start the Check Engine only after successful admission. It MUST pass the execution through the engine's existing absolute deadline, which is at most 10 seconds, without extending or replacing that limit. The handler MUST share cancellation with the engine so that an available client-disconnect or request-abort signal cancels the in-flight execution and triggers ownership-checked cleanup. A late resolver, transport, response, or cleanup callback MUST NOT cause a cancelled or timed-out run to emit a second result, acquire a new lease, alter a final result, or release another owner's state.

The route MUST be explicitly compatible with Node.js runtime behavior and MUST NOT require an Edge-only execution model. Client disconnect is not a client-visible result; if a response can no longer be delivered, the server MUST still attempt bounded cancellation and ownership-checked cleanup without persisting a result.

#### Scenario: Engine deadline expires

- GIVEN an admitted run is executing
- WHEN the Check Engine absolute deadline expires
- THEN the endpoint MUST return the engine's `timeout` result if the response remains deliverable
- AND it MUST release only its own coordination state exactly once
- AND later engine events MUST NOT change the completed result.

#### Scenario: Client disconnects while a run is active

- GIVEN an admitted run has started and the runtime exposes request cancellation
- WHEN the client disconnects before completion
- THEN the server MUST propagate cancellation to the in-flight execution
- AND it MUST perform ownership-checked cleanup
- AND it MUST NOT persist a run result or start replacement work.

### Requirement: Transient Accessible Monitor-Detail Experience

The project-scoped monitor detail interface MUST offer a Run Now control for an existing `ACTIVE` or `PAUSED` monitor. While its request is pending, the control MUST expose a busy state and MUST prevent duplicate client submissions. When it receives a successful endpoint result, it MUST render the typed outcome, latency, and available HTTP status as transient client state. It MUST present every typed outcome distinctly without inventing uptime, history, incidents, availability, or other telemetry.

When the endpoint returns a stable admission or endpoint error, the interface MUST render a recoverable, non-sensitive error state and re-enable the control when no request remains pending. The interface MUST preserve the current project context in its navigation and MUST provide keyboard-operable control semantics, visible focus, an accessible name, and polite live announcement of pending, result, and error changes. A page refresh or navigation away MAY clear the transient result.

#### Scenario: User runs a paused monitor from its detail page

- GIVEN the monitor detail page for a `PAUSED` monitor is rendered under project `P`
- WHEN a keyboard or pointer user activates Run Now
- THEN the control MUST enter a busy, disabled state while the request is pending
- AND the request MUST target the same project and monitor identifiers displayed by the page
- AND the returned result or stable error MUST be announced accessibly.

#### Scenario: Typed result is displayed without fabricated telemetry

- GIVEN the API returns `unexpected_status` with latency and an HTTP status
- WHEN the monitor detail interface renders the result
- THEN it MUST display that outcome, latency, and available status as the latest transient run result
- AND it MUST NOT display historical charts, uptime, incident counts, target URL, IP, response body, or any invented metric.

#### Scenario: Admission error is recoverable

- GIVEN the API returns `RUN_IN_PROGRESS`, `RUN_COOLDOWN`, `PROJECT_CONCURRENCY_LIMIT`, or `RUN_COORDINATION_UNAVAILABLE`
- WHEN the monitor detail interface receives the response
- THEN it MUST display a stable, non-sensitive recoverable error state
- AND it MUST clear busy state and permit a later user action when the server allows it.

### Requirement: Isolated Verification Coverage

The system MUST provide deterministic unit, route/integration, and browser-flow tests for this capability. Tests MUST inject the Check Engine, clock, Redis coordinator, and cancellation seams as needed; they MUST NOT contact public targets, modify development data, or depend on scheduler, worker, BullMQ processing, execution-history persistence, or a live external Redis service.

The test suite MUST cover successful execution, every engine typed outcome, invalid client input, same-project absence and cross-project isolation, duplicate runs, 30-second cooldown boundaries, the three-run project cap, Redis unavailability and partial/ownership failure behavior, lease expiry and late cleanup, redaction, cancellation, transient UI states, project-context-preserving paths, and keyboard/accessibility behavior.

#### Scenario: Boundary and ownership coordination is tested deterministically

- GIVEN injected coordinator and clock dependencies
- WHEN tests exercise concurrent admissions, cooldown at 29.999 and 30 seconds, lease expiry, and delayed owner cleanup
- THEN the tests MUST verify exactly one allowed owner where applicable
- AND they MUST verify no non-owner releases or decrements successor state
- AND no external network or live Redis instance is required.

#### Scenario: User-interface behavior is tested without a real target

- GIVEN injected API results for each stable endpoint error and each engine outcome
- WHEN browser or component tests exercise the monitor detail Run Now flow
- THEN tests MUST verify loading, success, error recovery, project-scoped request paths, keyboard activation, focus visibility, and live announcements
- AND the tests MUST not create persisted execution history or call a public HTTP target.
