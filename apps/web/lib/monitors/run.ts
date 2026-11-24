import "server-only";

import { createNativeHttpTransport, executeCheck, type CheckInput, type CheckResult } from "@api-watchdog/check-engine";
import { createProductionManualRunCoordinator } from "./run-coordinator";
import {
  apiFailure,
  apiJson,
  apiPathError,
  createMonitorApiDependencies,
  noStore,
  type MonitorApiOptions,
  type MonitorParams,
  type MonitorRecord,
} from "./http";

type Admission =
  | { kind: "admitted"; ownerToken: string }
  | { kind: "in_progress" | "cooldown" | "project_capacity" | "expired" | "unavailable" };
type Coordinator = { acquire(identity: MonitorParams): Promise<Admission>; release(input: MonitorParams & { ownerToken: string }): Promise<unknown> };
type Execute = (input: CheckInput, signal?: AbortSignal) => Promise<CheckResult>;

export type ManualRunOptions = MonitorApiOptions & {
  coordinator?: Coordinator;
  execute?: Execute;
};

const supportedMethods = new Set<MonitorRecord["method"]>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

function admissionFailure(admission: Exclude<Admission, { kind: "admitted" }>): Response {
  if (admission.kind === "in_progress") return apiFailure("RUN_IN_PROGRESS", "A run is already in progress", 409);
  if (admission.kind === "cooldown") return apiFailure("RUN_COOLDOWN", "Monitor is cooling down", 429);
  if (admission.kind === "project_capacity") return apiFailure("PROJECT_CONCURRENCY_LIMIT", "Project run capacity reached", 429);
  return apiFailure("RUN_COORDINATION_UNAVAILABLE", "Run coordination is unavailable", 503);
}

const BODY_INSPECTION_TIMEOUT_MS = 100;

type BodyRead =
  | { kind: "chunk"; result: ReadableStreamReadResult<Uint8Array> }
  | { kind: "error" }
  | { kind: "timeout" };

async function readBodyChunk(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number): Promise<BodyRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const chunk = reader.read().then(
    (result): BodyRead => ({ kind: "chunk", result }),
    (): BodyRead => ({ kind: "error" }),
  );
  const timeout = new Promise<BodyRead>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([chunk, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function hasBody(request: Request): Promise<boolean> {
  if (request.body === null) return false;

  const reader = request.body.getReader();
  const deadline = Date.now() + BODY_INSPECTION_TIMEOUT_MS;
  try {
    while (true) {
      const read = await readBodyChunk(reader, deadline - Date.now());
      if (read.kind !== "chunk") return true;
      if (read.result.done) return false;
      if (read.result.value.byteLength > 0) return true;
    }
  } catch {
    return true;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createManualRunHandlers(options: ManualRunOptions = {}) {
  const { repository, resolver } = createMonitorApiDependencies(options);
  const coordinator = options.coordinator ?? createProductionManualRunCoordinator();
  const execute: Execute = options.execute ?? ((input, signal) => executeCheck(input, { resolver, transport: createNativeHttpTransport(), signal }));

  const POST = async (request: Request, params: MonitorParams): Promise<Response> => {
    const invalid = apiPathError(params);
    if (invalid || new URL(request.url).search || await hasBody(request)) return invalid ?? apiFailure("INVALID_REQUEST", "Invalid request", 400);
    let monitor: MonitorRecord | null;
    try {
      monitor = await repository.get(params.projectId, params.monitorId);
    } catch {
      return apiFailure("INTERNAL_ERROR", "An unexpected error occurred", 500);
    }
    if (!monitor) return apiFailure("MONITOR_NOT_FOUND", "Monitor not found", 404);
    if (!supportedMethods.has(monitor.method)) return apiFailure("INTERNAL_ERROR", "An unexpected error occurred", 500);

    const admission = await coordinator.acquire(params);
    if (admission.kind !== "admitted") return admissionFailure(admission);
    try {
      const result = await execute({ url: monitor.url, method: monitor.method as CheckInput["method"], timeoutMs: monitor.timeoutMs, expectedStatus: monitor.expectedStatus }, request.signal);
      return apiJson({ data: result }, 200, noStore);
    } catch {
      return apiFailure("INTERNAL_ERROR", "An unexpected error occurred", 500);
    } finally {
      try {
        await coordinator.release({ ...params, ownerToken: admission.ownerToken });
      } catch {
        // The finite owner lease safely bounds a failed cleanup attempt.
      }
    }
  };

  return { POST };
}

export const manualRunHandlers = createManualRunHandlers();
