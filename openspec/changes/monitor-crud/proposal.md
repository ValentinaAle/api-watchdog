# Proposal: Project-Scoped Monitor Management

## Intent

Enable users to create, inspect, update, pause, resume, and permanently delete API monitors within a project. The current foundation has a `Project` model but no `Monitor` model or management flow. This change records monitor configuration safely without executing user-supplied URLs; it establishes boundaries that a later BullMQ-driven monitoring worker must respect.

## Scope

### In Scope

- Add a Prisma `Monitor` owned by `Project` through a required `projectId`, with PostgreSQL persistence and a migration.
- Provide full monitor CRUD and pause/resume through Next.js Route Handlers and a modular frontend/backend/database separation. Hard delete removes the monitor rather than soft-deleting it.
- Require name, URL, HTTP method, interval, timeout, expected HTTP status, and active/paused status. Validate name length 1–100 characters, interval 30–86400 seconds, timeout 1000–60000 milliseconds, and expected status 100–599 with Zod at the API boundary.
- Define and enforce a safe target policy for stored URLs, including IPv4 and IPv6, loopback, link-local, private and reserved address ranges, internal domains, cloud metadata destinations, and DNS-resolved destination validation. Define the future worker contract to repeat validation for every connection and prevent unsafe redirects.
- Build monitor management UI using the available Stitch designs as visual reference without a general redesign. Only the overview is known to be locally available; other Stitch screens must not be assumed to be local files.
- Add focused unit and API/database integration tests, plus appropriate end-to-end coverage for the management flow.
- Keep changes in reviewable PR slices of at most 400 authored changed lines per PR unless a maintainer later authorizes `size:exception`.

### Out of Scope

- Executing monitor requests, scheduling checks, enqueueing BullMQ jobs, collecting results, or alerting. CRUD actions must not execute URLs or enqueue checks.
- Storing credentials or other secrets as plain text, or logging secrets. Secret-bearing monitor configuration is not part of this CRUD scope.
- General application redesign or implementing unrelated Stitch screens.
- Project CRUD, authentication, and authorization systems not already established by the project.

## Capabilities

No existing specifications are present under `openspec/specs/`.

### New Capabilities

- `monitor-management`: Project-scoped monitor persistence, validated CRUD, hard deletion, pause/resume, and the management UI.
- `monitor-target-safety`: URL admission and SSRF boundaries for stored targets, with a future execution contract requiring per-connection DNS/address verification and safe redirect handling.

### Modified Capabilities

None.

## Approach

Introduce the required Project-to-Monitor relation in Prisma and keep persistence access in `packages/database`. Put reusable monitor input and target validation in `packages/validation`, expose project-scoped Next.js Route Handlers in `apps/web`, and build UI components in the web app using Stitch as a visual reference. Separate API validation, persistence, and presentation so the existing scheduler and worker processes remain unaffected by CRUD. Store the pause state explicitly and have future execution eligibility depend on it; no queue or outbound HTTP operation is introduced now.

The URL policy must reject unsafe literal hosts and resolved addresses at admission, but storage-time checks alone are not an execution guarantee because DNS and redirects can change. The later worker must use an SSRF-safe transport that resolves and verifies the actual destination for each connection, including redirects, rather than trusting previously validated DNS answers. Do not add plaintext secret fields or secret-bearing logs.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/database/prisma/schema.prisma` and migration directory | Modified | Required Project/Monitor relation and persisted monitor fields. |
| `packages/database/src/` | Modified | Monitor persistence access. |
| `packages/validation/src/` | Modified | Monitor field and safe-target validation. |
| `apps/web/app/` | Modified | Route Handlers and project-scoped management UI. |
| `tests/` | Modified | Unit, integration, and appropriate e2e coverage. |
| `workers/monitor-worker/` and `packages/queue/` | Unchanged | Future consumer contract only; no execution or enqueueing in this change. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| SSRF through DNS rebinding, IPv6, internal names, cloud metadata, or redirects | High | Test deny cases; keep CRUD non-executing; require per-connection destination checks and redirect controls before worker execution is introduced. |
| Hard deletion permanently removes monitor configuration | Medium | Confirm the destructive action in UI, test the endpoint, and document that rollback cannot restore deleted production rows without backup. |
| Project scoping mistakes expose or mutate another project's monitor | Medium | Require `projectId` in relation and scope all queries and mutation lookups to the selected project; integration-test cross-project IDs. |
| Scope crosses the 400-line review budget | High | Split schema/validation/API/UI/tests into coherent, independently reviewable PR slices; do not use an unapproved size exception. |

## Rollback Plan

Revert the application PR slices in reverse dependency order and disable the monitor UI/routes before reverting schema changes. Preserve a database backup before any destructive migration rollback; existing monitor rows and hard-deleted rows cannot be recovered by code rollback alone. No queue jobs or outbound checks need draining because this change does not enqueue or execute them.

## Dependencies

- Existing PostgreSQL/Prisma, Next.js, Zod, and pnpm workspace foundation.
- Stitch designs as visual reference; do not assume non-overview screens exist locally.
- A running PostgreSQL instance for integration and migration checks, and a running web app for Playwright e2e checks.

## Success Criteria

- [ ] A monitor cannot exist without a valid owning project, and project-scoped CRUD cannot access another project's monitor.
- [ ] Create, list/read, update, pause, resume, and hard delete work through Route Handlers and the UI.
- [ ] Required fields and numeric/string bounds are enforced consistently by Zod and tested at boundaries.
- [ ] Unsafe literal or DNS-resolved targets are rejected for IPv4/IPv6, local/private/reserved/internal/metadata destinations; the future worker per-connection and redirect safety contract is specified.
- [ ] CRUD operations never fetch a target URL or enqueue a check; no plaintext secret field or secret-bearing log is introduced.
- [ ] Focused unit and integration checks pass, with appropriate management-flow e2e coverage; any unavailable checks are reported.
- [ ] Each PR slice stays within 400 authored changed lines or has a separately approved `size:exception`.
