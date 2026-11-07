import { NextResponse } from "next/server";
import { promises as dns } from "node:dns";
import {
  createMonitor,
  deleteMonitor,
  getMonitor,
  listMonitors,
  updateMonitor,
} from "@api-watchdog/database";
import { prisma } from "@api-watchdog/database";
import { MonitorTargetAdmissionError, type MonitorDnsResolver } from "@api-watchdog/validation";

export type ProjectParams = { projectId: string };
export type MonitorParams = ProjectParams & { monitorId: string };
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
export type MonitorStatus = "ACTIVE" | "PAUSED";
export type MonitorRecord = {
  id: string;
  projectId: string;
  name: string;
  url: string;
  method: HttpMethod;
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: number;
  status: MonitorStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type MonitorRepository = {
  projectExists(projectId: string): Promise<boolean>;
  create(input: {
    projectId: string;
    name: string;
    url: string;
    method: HttpMethod;
    intervalSeconds: number;
    timeoutMs: number;
    expectedStatus: number;
    status: MonitorStatus;
  }): Promise<MonitorRecord>;
  list(projectId: string): Promise<MonitorRecord[]>;
  get(projectId: string, monitorId: string): Promise<MonitorRecord | null>;
  update(projectId: string, monitorId: string, input: Partial<{
    name: string;
    url: string;
    method: HttpMethod;
    intervalSeconds: number;
    timeoutMs: number;
    expectedStatus: number;
    status: MonitorStatus;
  }>): Promise<MonitorRecord | null>;
  delete(projectId: string, monitorId: string): Promise<boolean>;
};

export type MonitorApiOptions = {
  resolver?: MonitorDnsResolver;
  repository?: MonitorRepository;
};

export type MonitorApiDependencies = Required<MonitorApiOptions>;
export type Handler<Params> = (request: Request, params: Params) => Promise<Response>;

export const noStore = { "Cache-Control": "no-store" };

const defaultRepository: MonitorRepository = {
  projectExists: async (projectId) => Boolean(await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })),
  create: createMonitor,
  list: listMonitors,
  get: getMonitor,
  update: updateMonitor,
  delete: deleteMonitor,
};

const defaultResolver: MonitorDnsResolver = {
  resolve4: (hostname) => dns.resolve4(hostname),
  resolve6: (hostname) => dns.resolve6(hostname),
};

export function createMonitorApiDependencies(options: MonitorApiOptions = {}): MonitorApiDependencies {
  return { repository: options.repository ?? defaultRepository, resolver: options.resolver ?? defaultResolver };
}

export function apiJson(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return NextResponse.json(data, { status, headers });
}

export function apiFailure(code: string, message: string, status: number, issues?: unknown): Response {
  const error = issues === undefined ? { code, message } : { code, message, issues };
  return apiJson({ error }, status, noStore);
}

export function apiPathError(params: ProjectParams | MonitorParams): Response | undefined {
  const cuidPattern = /^c[a-z0-9]{24}$/i;
  if (!cuidPattern.test(params.projectId)) return apiFailure("INVALID_REQUEST", "Invalid request", 400);
  if ("monitorId" in params && !cuidPattern.test(params.monitorId)) {
    return apiFailure("INVALID_REQUEST", "Invalid request", 400);
  }
  return undefined;
}

export function safeIssues(issues: Array<{ path: PropertyKey[] }>) {
  return issues.map(({ path }) => ({ path: path.map(String), message: "Invalid value" }));
}

export function issueIsUrl(issues: Array<{ path: PropertyKey[] }>): boolean {
  return issues.some(({ path }) => path[0] === "url");
}

function prismaCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function apiUnexpected(error: unknown, create = false): Response {
  if (error instanceof MonitorTargetAdmissionError) {
    const message = error.code === "UNSAFE_TARGET" ? "Monitor target is not permitted" : "Monitor target could not be verified";
    return apiFailure(error.code, message, 422);
  }
  const code = prismaCode(error);
  if (create && code === "P2003") return apiFailure("PROJECT_NOT_FOUND", "Project not found", 404);
  if (code && ["P1000", "P1001", "P1002", "P2024"].includes(code)) {
    return apiFailure("SERVICE_UNAVAILABLE", "Service is temporarily unavailable", 503);
  }
  return apiFailure("INTERNAL_ERROR", "An unexpected error occurred", 500);
}

export function serializeMonitor(monitor: MonitorRecord) {
  return {
    id: monitor.id,
    projectId: monitor.projectId,
    name: monitor.name,
    url: monitor.url,
    method: monitor.method,
    intervalSeconds: monitor.intervalSeconds,
    timeoutMs: monitor.timeoutMs,
    expectedStatus: monitor.expectedStatus,
    status: monitor.status.toLowerCase(),
    createdAt: monitor.createdAt.toISOString(),
    updatedAt: monitor.updatedAt.toISOString(),
  };
}

export function databaseStatus(status: string): MonitorStatus {
  return status.toUpperCase() as MonitorStatus;
}

export async function parseRequestJson(request: Request): Promise<{ value?: unknown; error?: Response }> {
  try {
    return { value: await request.json() };
  } catch {
    return { error: apiFailure("INVALID_REQUEST", "Request body must be valid JSON", 400) };
  }
}
