# Monitor Target Safety Contract

Current URL admission is a creation-time policy check, not permission to connect. A future worker must independently re-resolve and validate each hostname immediately before every connection, reject the entire answer set if any address is prohibited, and pin the socket to a validated address while preserving the intended Host header and TLS SNI.

Disable automatic redirects. For every redirect hop, enforce a bounded redirect count, parse and validate the new URL, re-resolve and validate all A/AAAA answers, and pin that hop's connection to a validated address. Never carry an earlier hop's DNS approval forward.

These controls prevent DNS rebinding and unsafe redirect pivots. Proxy behavior must also be constrained so it cannot bypass destination validation. No worker, scheduler, target HTTP request, or connection pinning is implemented by this admission-only change.
