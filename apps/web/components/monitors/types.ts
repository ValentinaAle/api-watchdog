export type Monitor = {
  id: string;
  projectId: string;
  name: string;
  url: string;
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: number;
  status: "active" | "paused";
  createdAt: string;
  updatedAt: string;
};

export type ApiError = { error?: { code?: string; message?: string; issues?: Array<{ path?: string[]; message?: string }> } };

export type ManualRunOutcome = "success" | "unexpected_status" | "dns_failure" | "connection_failure" | "tls_or_protocol_failure" | "timeout" | "response_limit";
export type ManualRunResult = { outcome: ManualRunOutcome; latencyMs: number; statusCode?: number };
type ManualRunEndpointCode = "RUN_IN_PROGRESS" | "RUN_COOLDOWN" | "PROJECT_CONCURRENCY_LIMIT" | "RUN_COORDINATION_UNAVAILABLE" | "INTERNAL_ERROR";
export type ManualRunState = { pending: boolean; result?: ManualRunResult; error?: string };
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const manualRunOutcomes = new Set<ManualRunOutcome>([
  "success",
  "unexpected_status",
  "dns_failure",
  "connection_failure",
  "tls_or_protocol_failure",
  "timeout",
  "response_limit",
]);

const endpointMessages: Record<ManualRunEndpointCode, string> = {
  RUN_IN_PROGRESS: "A run is already in progress for this monitor.",
  RUN_COOLDOWN: "This monitor is cooling down before another run.",
  PROJECT_CONCURRENCY_LIMIT: "This project has reached its manual run capacity.",
  RUN_COORDINATION_UNAVAILABLE: "Manual runs are temporarily unavailable.",
  INTERNAL_ERROR: "The manual run could not be completed.",
};

export async function readApiError(response: Response): Promise<ApiError["error"]> {
  try {
    const body = await response.json() as ApiError;
    return body.error ?? { message: "The request could not be completed." };
  } catch {
    return { message: "The request could not be completed." };
  }
}

export function monitorApiPath(projectId: string, monitorId?: string) {
  const collection = `/api/projects/${encodeURIComponent(projectId)}/monitors`;
  return monitorId ? `${collection}/${encodeURIComponent(monitorId)}` : collection;
}

export function monitorActionApiPath(projectId: string, monitorId: string, action: "pause" | "resume") {
  return `${monitorApiPath(projectId, monitorId)}/${action}`;
}

export function manualRunApiPath(projectId: string, monitorId: string) {
  return `${monitorApiPath(projectId, monitorId)}/run`;
}

export function parseManualRunResult(value: unknown): ManualRunResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { outcome, latencyMs, statusCode, ...extra } = value as Record<string, unknown>;
  if (Object.keys(extra).length || typeof outcome !== "string" || !manualRunOutcomes.has(outcome as ManualRunOutcome) || typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0) return undefined;
  if (statusCode !== undefined && (typeof statusCode !== "number" || !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)) return undefined;
  return statusCode === undefined ? { outcome: outcome as ManualRunOutcome, latencyMs } : { outcome: outcome as ManualRunOutcome, latencyMs, statusCode };
}

function endpointMessage(value: unknown): string {
  const code = value && typeof value === "object" && !Array.isArray(value) ? (value as { error?: { code?: unknown } }).error?.code : undefined;
  return typeof code === "string" && code in endpointMessages ? endpointMessages[code as ManualRunEndpointCode] : endpointMessages.INTERNAL_ERROR;
}

export function manualRunOutcomeMessage(outcome: ManualRunOutcome): string {
  return {
    success: "Check succeeded.",
    unexpected_status: "The response status did not match the monitor expectation.",
    dns_failure: "The destination could not be resolved.",
    connection_failure: "The destination could not be reached.",
    tls_or_protocol_failure: "The secure connection could not be completed.",
    timeout: "The check timed out.",
    response_limit: "The response exceeded the safety limit.",
  }[outcome];
}

export function createManualRunClient(input: {
  projectId: string;
  monitorId: string;
  fetcher: Fetcher;
  onStateChange(state: ManualRunState): void;
}) {
  let pending = false;
  let disposed = false;
  let controller: AbortController | undefined;
  const publish = (state: ManualRunState) => { if (!disposed) input.onStateChange(state); };

  return {
    async run() {
      if (pending || disposed) return;
      pending = true;
      const currentController = new AbortController();
      controller = currentController;
      publish({ pending: true });
      try {
        const response = await input.fetcher(manualRunApiPath(input.projectId, input.monitorId), { method: "POST", signal: currentController.signal });
        if (disposed || controller !== currentController) return;
        if (!response.ok) {
          let body: unknown;
          try { body = await response.json(); } catch { body = undefined; }
          publish({ pending: false, error: endpointMessage(body) });
          return;
        }
        let body: unknown;
        try { body = await response.json(); } catch { body = undefined; }
        const result = body && typeof body === "object" ? parseManualRunResult((body as { data?: unknown }).data) : undefined;
        publish(result ? { pending: false, result } : { pending: false, error: endpointMessages.INTERNAL_ERROR });
      } catch {
        if (!disposed && controller === currentController) publish({ pending: false, error: "The monitor service could not be reached." });
      } finally {
        if (controller === currentController) controller = undefined;
        pending = false;
      }
    },
    dispose() {
      disposed = true;
      controller?.abort();
      controller = undefined;
      pending = false;
    },
  };
}

export function formatInterval(seconds: number) {
  if (seconds % 3600 === 0) return `${seconds / 3600} hr`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} sec`;
}

export function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
