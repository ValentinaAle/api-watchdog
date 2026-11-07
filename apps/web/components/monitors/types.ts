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

export async function readApiError(response: Response): Promise<ApiError["error"]> {
  try {
    const body = await response.json() as ApiError;
    return body.error ?? { message: "The request could not be completed." };
  } catch {
    return { message: "The request could not be completed." };
  }
}

export function projectMonitorsPath(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}/monitors`;
}

export function monitorApiPath(projectId: string, monitorId?: string) {
  const collection = `/api/projects/${encodeURIComponent(projectId)}/monitors`;
  return monitorId ? `${collection}/${encodeURIComponent(monitorId)}` : collection;
}

export function monitorActionApiPath(projectId: string, monitorId: string, action: "pause" | "resume") {
  return `${monitorApiPath(projectId, monitorId)}/${action}`;
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
