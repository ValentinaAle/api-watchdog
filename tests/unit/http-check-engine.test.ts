import { describe, expect, it, vi } from "vitest";
import {
  CheckTransportError,
  MAX_EXECUTION_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
} from "../../packages/check-engine/src/index.ts";
import { executeCheck } from "../../packages/check-engine/src/engine.ts";

const input = {
  url: "https://monitor.example.com/health?token=private",
  method: "GET" as const,
  timeoutMs: 5_000,
  expectedStatus: 200,
};

function resolver() {
  return {
    resolve4: vi.fn(async () => ["8.8.8.8"]),
    resolve6: vi.fn(async () => ["2606:4700:4700::1111"]),
  };
}

function transport(statusCode = 200) {
  const requests: unknown[] = [];
  return {
    requests,
    execute: vi.fn(async (request: unknown) => {
      requests.push(request);
      return { statusCode };
    }),
  };
}

describe("http check engine", () => {
  it("returns success with latency and the received expected status", async () => {
    const clock = { now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(145) };
    await expect(executeCheck(input, { resolver: resolver(), transport: transport(), clock })).resolves.toEqual({
      outcome: "success",
      latencyMs: 45,
      statusCode: 200,
    });
  });

  it("returns unexpected status without exposing target details", async () => {
    const result = await executeCheck(input, { resolver: resolver(), transport: transport(503) });
    expect(result).toMatchObject({ outcome: "unexpected_status", statusCode: 503 });
    expect(JSON.stringify(result)).not.toContain("monitor.example.com");
  });

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const)("passes %s without body-capable options", async (method) => {
    const testTransport = transport();
    await executeCheck({ ...input, method }, { resolver: resolver(), transport: testTransport });
    expect(testTransport.execute).toHaveBeenCalledWith(expect.objectContaining({
      method,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    }));
    expect(Object.keys(testTransport.requests[0] as object)).not.toContain("body");
    expect(Object.keys(testTransport.requests[0] as object)).not.toContain("headers");
  });

  it.each([
    [new CheckTransportError("connection_failure"), "connection_failure"],
    [new CheckTransportError("tls_or_protocol_failure"), "tls_or_protocol_failure"],
    [new CheckTransportError("response_limit"), "response_limit"],
  ] as const)("maps safe transport failure %s", async (error, outcome) => {
    const failingTransport = { execute: vi.fn(async () => { throw error; }) };
    await expect(executeCheck(input, { resolver: resolver(), transport: failingTransport })).resolves.toMatchObject({ outcome });
  });

  it("maps resolver errors to a redacted DNS failure without dispatching transport", async () => {
    const failingResolver = resolver();
    failingResolver.resolve4.mockRejectedValue(new Error("https://secret.example/?token=x 10.0.0.1"));
    const testTransport = transport();
    const result = await executeCheck(input, { resolver: failingResolver, transport: testTransport });
    expect(result.outcome).toBe("dns_failure");
    expect(testTransport.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/secret|10\.0\.0\.1|token/);
  });

  it("clamps the transport deadline to the system maximum", async () => {
    const testTransport = transport();
    await executeCheck({ ...input, timeoutMs: 60_000 }, { resolver: resolver(), transport: testTransport });
    expect(testTransport.execute).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: MAX_EXECUTION_TIMEOUT_MS }));
  });

  it("rejects invalid execution input before resolver or transport side effects", async () => {
    const testResolver = resolver();
    const testTransport = transport();
    await expect(executeCheck({ ...input, expectedStatus: 99 }, { resolver: testResolver, transport: testTransport }))
      .resolves.toMatchObject({ outcome: "tls_or_protocol_failure" });
    expect(testResolver.resolve4).not.toHaveBeenCalled();
    expect(testTransport.execute).not.toHaveBeenCalled();
  });

  it("does not dispatch a transport when DNS resolves after the absolute deadline", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const delayed = new Promise<readonly string[]>((resolve) => { release = () => resolve(["8.8.8.8"]); });
      const delayedResolver = {
        resolve4: vi.fn((_hostname: string, _options?: { signal?: AbortSignal }) => delayed),
        resolve6: vi.fn(async (_hostname: string, _options?: { signal?: AbortSignal }) => []),
      };
      const testTransport = transport();
      const run = executeCheck({ ...input, timeoutMs: 1_000 }, { resolver: delayedResolver, transport: testTransport });
      await vi.advanceTimersByTimeAsync(1_000);
      release();
      await expect(run).resolves.toMatchObject({ outcome: "timeout" });
      expect(testTransport.execute).not.toHaveBeenCalled();
      expect(delayedResolver.resolve4.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts an in-flight resolver and releases it without dispatching transport", async () => {
    vi.useFakeTimers();
    try {
      let activeResolvers = 0;
      let resolverAborts = 0;
      const waitForAbort = (signal?: AbortSignal) => new Promise<readonly string[]>((_resolve, reject) => {
        activeResolvers += 1;
        signal?.addEventListener("abort", () => {
          resolverAborts += 1;
          activeResolvers -= 1;
          reject(new Error("resolver aborted"));
        }, { once: true });
      });
      const abortAwareResolver = {
        resolve4: vi.fn((_hostname: string, options?: { signal?: AbortSignal }) => waitForAbort(options?.signal)),
        resolve6: vi.fn(async () => []),
      };
      const testTransport = transport();
      const run = executeCheck({ ...input, timeoutMs: 1_000 }, { resolver: abortAwareResolver, transport: testTransport });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(run).resolves.toMatchObject({ outcome: "timeout" });
      expect(resolverAborts).toBe(1);
      expect(activeResolvers).toBe(0);
      expect(testTransport.execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("proves an active transport settles when the shared signal aborts", async () => {
    vi.useFakeTimers();
    try {
      let activeTransports = 0;
      let abortListeners = 0;
      let cleanupCalls = 0;
      let transportSettled = false;
      let abortReceived = false;
      let internalTransportPromise: Promise<{ statusCode: number }> | undefined;
      let transportSettlement: Promise<void> | undefined;
      const cooperativeTransport = {
        execute: vi.fn(({ signal }: { signal: AbortSignal }) => {
          const pending = new Promise<{ statusCode: number }>((_resolve, reject) => {
          activeTransports += 1;
          const onAbort = () => {
            abortReceived = true;
            cleanupCalls += 1;
            signal.removeEventListener("abort", onAbort);
            abortListeners -= 1;
            activeTransports -= 1;
            reject(new Error("transport aborted"));
          };
          abortListeners += 1;
          signal.addEventListener("abort", onAbort, { once: true });
          });
          internalTransportPromise = pending;
          transportSettlement = pending.then(
            () => { transportSettled = true; },
            () => { transportSettled = true; },
          );
          return pending;
        }),
      };
      const run = executeCheck({ ...input, timeoutMs: 1_000 }, { resolver: resolver(), transport: cooperativeTransport });
      await vi.advanceTimersByTimeAsync(0);
      expect(cooperativeTransport.execute).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      const timeoutResult = await run;
      expect(timeoutResult).toMatchObject({ outcome: "timeout" });
      expect(abortReceived).toBe(true);
      expect(internalTransportPromise).toBeDefined();
      expect(transportSettlement).toBeDefined();
      await transportSettlement;
      expect(activeTransports).toBe(0);
      expect(abortListeners).toBe(0);
      expect(cleanupCalls).toBe(1);
      expect(transportSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps timeout after a non-cooperative transport completes late", async () => {
    vi.useFakeTimers();
    try {
      let activeTransports = 0;
      let abortObserved = false;
      let completeLate!: () => void;
      const nonCooperativeTransport = {
        execute: vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<{ statusCode: number }>((resolve) => {
          activeTransports += 1;
          completeLate = () => {
            activeTransports -= 1;
            resolve({ statusCode: 200 });
          };
          signal.addEventListener("abort", () => { abortObserved = true; }, { once: true });
        })),
      };
      const run = executeCheck({ ...input, timeoutMs: 1_000 }, { resolver: resolver(), transport: nonCooperativeTransport });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      const timeoutResult = await run;
      expect(timeoutResult).toMatchObject({ outcome: "timeout" });
      expect(nonCooperativeTransport.execute).toHaveBeenCalledTimes(1);
      expect(abortObserved).toBe(true);
      expect(activeTransports).toBe(1);
      completeLate();
      await Promise.resolve();
      expect(activeTransports).toBe(0);
      expect(timeoutResult).toMatchObject({ outcome: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
