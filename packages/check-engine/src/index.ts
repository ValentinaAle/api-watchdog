export type {
  CheckInput,
  CheckOutcome,
  CheckResult,
  CheckClock,
  CheckDependencies,
  ConstrainedTransport,
  TransportRequest,
  TransportResponse,
} from "./types.ts";
export { MAX_EXECUTION_TIMEOUT_MS, MAX_RESPONSE_BYTES, CheckTransportError } from "./types.ts";
export { executeCheck } from "./engine.ts";
