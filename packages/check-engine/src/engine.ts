import {
  MonitorTargetAdmissionError,
  resolveMonitorExecutionTarget,
} from "@api-watchdog/validation";
import {
  CheckTransportError,
  MAX_EXECUTION_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  type CheckDependencies,
  type CheckInput,
  type CheckOutcome,
  type CheckResult,
} from "./types.ts";

const supportedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

class DeadlineExceededError extends Error {}

function result(outcome: CheckOutcome, startedAt: number, now: () => number, statusCode?: number): CheckResult {
  return Object.freeze({
    outcome,
    latencyMs: Math.max(0, now() - startedAt),
    ...(statusCode === undefined ? {} : { statusCode }),
  });
}

function isValidInput(input: CheckInput): boolean {
  return typeof input.url === "string" &&
    supportedMethods.has(input.method) &&
    Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 &&
    Number.isInteger(input.expectedStatus) && input.expectedStatus >= 100 && input.expectedStatus <= 599;
}

function awaitBeforeDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(new DeadlineExceededError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DeadlineExceededError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        signal.aborted ? reject(new DeadlineExceededError()) : resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        signal.aborted ? reject(new DeadlineExceededError()) : reject(error);
      },
    );
  });
}

function mapFailure(error: unknown): CheckOutcome {
  if (error instanceof DeadlineExceededError) return "timeout";
  if (error instanceof MonitorTargetAdmissionError) return "dns_failure";
  if (error instanceof CheckTransportError) return error.outcome;
  return "connection_failure";
}

/** Executes one injected, address-pinned transport attempt without logging target details. */
export async function executeCheck(input: CheckInput, dependencies: CheckDependencies): Promise<CheckResult> {
  const now = dependencies.clock?.now ?? Date.now;
  const startedAt = now();
  if (!isValidInput(input)) return result("tls_or_protocol_failure", startedAt, now);

  const timeoutMs = Math.min(input.timeoutMs, MAX_EXECUTION_TIMEOUT_MS);
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (dependencies.signal?.aborted) controller.abort();
  else dependencies.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const target = await awaitBeforeDeadline(
      resolveMonitorExecutionTarget(input.url, dependencies.resolver, { signal: controller.signal }),
      controller.signal,
    );
    if (controller.signal.aborted) throw new DeadlineExceededError();

    const response = await awaitBeforeDeadline(
      dependencies.transport.execute({
        target,
        address: target.addresses[0]!,
        method: input.method,
        timeoutMs,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (!Number.isInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) {
      return result("tls_or_protocol_failure", startedAt, now);
    }
    return result(response.statusCode === input.expectedStatus ? "success" : "unexpected_status", startedAt, now, response.statusCode);
  } catch (error) {
    return result(mapFailure(error), startedAt, now);
  } finally {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener("abort", onExternalAbort);
  }
}
