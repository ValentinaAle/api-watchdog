# Architecture decisions

API Watchdog starts as a modular monolith. The web app owns HTTP/UI concerns, while scheduler and worker are independent Node processes. PostgreSQL is the source of truth; Redis/BullMQ provides asynchronous execution.

The first milestone intentionally does not execute user-provided URLs. Future monitoring execution must use an SSRF-safe HTTP transport with address validation before every connection and redirect.
