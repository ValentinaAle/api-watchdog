import { admitMonitorTarget, monitorUpdateSchema } from "@api-watchdog/validation";
import {
  apiFailure,
  apiJson,
  apiPathError,
  apiUnexpected,
  createMonitorApiDependencies,
  issueIsUrl,
  parseRequestJson,
  safeIssues,
  serializeMonitor,
  type Handler,
  type MonitorApiOptions,
  type MonitorParams,
} from "./http";

export function createMonitorItemHandlers(options: MonitorApiOptions = {}) {
  const { repository, resolver } = createMonitorApiDependencies(options);

  const GET: Handler<MonitorParams> = async (_request, params) => {
    const invalid = apiPathError(params);
    if (invalid) return invalid;
    try {
      const monitor = await repository.get(params.projectId, params.monitorId);
      return monitor ? apiJson({ data: serializeMonitor(monitor) }, 200, { "Cache-Control": "no-store" })
        : apiFailure("MONITOR_NOT_FOUND", "Monitor not found", 404);
    } catch (error) {
      return apiUnexpected(error);
    }
  };

  const PATCH: Handler<MonitorParams> = async (request, params) => {
    const invalid = apiPathError(params);
    if (invalid) return invalid;
    const body = await parseRequestJson(request);
    if (body.error) return body.error;
    const parsed = monitorUpdateSchema.safeParse(body.value);
    if (!parsed.success) {
      if (issueIsUrl(parsed.error.issues)) {
        return apiFailure("UNSAFE_TARGET", "Monitor target is not permitted", 422);
      }
      return apiFailure("INVALID_REQUEST", "Request contains invalid fields", 400, safeIssues(parsed.error.issues));
    }
    try {
      const url = parsed.data.url === undefined
        ? undefined
        : await admitMonitorTarget(parsed.data.url, { resolver });
      const monitor = await repository.update(params.projectId, params.monitorId, {
        ...parsed.data,
        ...(url === undefined ? {} : { url }),
      });
      return monitor ? apiJson({ data: serializeMonitor(monitor) })
        : apiFailure("MONITOR_NOT_FOUND", "Monitor not found", 404);
    } catch (error) {
      return apiUnexpected(error);
    }
  };

  const DELETE: Handler<MonitorParams> = async (_request, params) => {
    const invalid = apiPathError(params);
    if (invalid) return invalid;
    try {
      return await repository.delete(params.projectId, params.monitorId)
        ? new Response(null, { status: 204 })
        : apiFailure("MONITOR_NOT_FOUND", "Monitor not found", 404);
    } catch (error) {
      return apiUnexpected(error);
    }
  };

  return { GET, PATCH, DELETE };
}

export const monitorItemHandlers = createMonitorItemHandlers();
