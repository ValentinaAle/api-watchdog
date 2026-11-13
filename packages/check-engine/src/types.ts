import type { MonitorDnsResolver, MonitorExecutionAddress, MonitorExecutionTarget } from "@api-watchdog/validation";

export const MAX_EXECUTION_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 1_048_576;

export type CheckMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export type CheckInput = Readonly<{
  url: string;
  method: CheckMethod;
  timeoutMs: number;
  expectedStatus: number;
}>;

export type CheckOutcome =
  | "success"
  | "unexpected_status"
  | "dns_failure"
  | "connection_failure"
  | "tls_or_protocol_failure"
  | "timeout"
  | "response_limit";

export type CheckResult = Readonly<{
  outcome: CheckOutcome;
  latencyMs: number;
  statusCode?: number;
}>;

export type CheckClock = Readonly<{ now(): number }>;

export type TransportRequest = Readonly<{
  target: MonitorExecutionTarget;
  address: MonitorExecutionAddress;
  method: CheckMethod;
  timeoutMs: number;
  maxResponseBytes: number;
  signal: AbortSignal;
}>;

export type TransportResponse = Readonly<{ statusCode: number }>;

export type ConstrainedTransport = Readonly<{
  execute(request: TransportRequest): Promise<TransportResponse>;
}>;

export type CheckDependencies = Readonly<{
  resolver: MonitorDnsResolver;
  transport: ConstrainedTransport;
  clock?: CheckClock;
}>;

export class CheckTransportError extends Error {
  constructor(readonly outcome: Exclude<CheckOutcome, "success" | "unexpected_status" | "dns_failure" | "timeout">) {
    super(outcome);
    this.name = "CheckTransportError";
  }
}
