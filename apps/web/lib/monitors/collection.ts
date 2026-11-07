import { admitMonitorTarget, monitorCreateSchema } from "@api-watchdog/validation";
import {
  apiFailure,
  apiJson,
  apiPathError,
  apiUnexpected,
  createMonitorApiDependencies,
  databaseStatus,
  issueIsUrl,
  parseRequestJson,
  safeIssues,
  serializeMonitor,
  type Handler,
  type MonitorApiOptions,
  type ProjectParams,
} from "./http";

export function createMonitorCollectionHandlers(options: MonitorApiOptions = {}) {
  const { repository, resolver } = createMonitorApiDependencies(options);
  const GET: Handler<ProjectParams> = async (_request, params) => {
    const invalid = apiPathError(params);
    if (invalid) return invalid;
    try {
      if (!(await repository.projectExists(params.projectId))) {
        return apiFailure("PROJECT_NOT_FOUND", "Project not found", 404);
      }
      return apiJson({ data: (await repository.list(params.projectId)).map(serializeMonitor) }, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      return apiUnexpected(error);
    }
  };

  const POST: Handler<ProjectParams> = async (request, params) => {
    const invalid = apiPathError(params);
    if (invalid) return invalid;
    const body = await parseRequestJson(request);
    if (body.error) return body.error;
    const parsed = monitorCreateSchema.safeParse(body.value);
    if (!parsed.success) {
      if (issueIsUrl(parsed.error.issues)) {
        return apiFailure("UNSAFE_TARGET", "Monitor target is not permitted", 422);
      }
      return apiFailure("INVALID_REQUEST", "Request contains invalid fields", 400, safeIssues(parsed.error.issues));
    }
    try {
      const url = await admitMonitorTarget(parsed.data.url, { resolver });
      const monitor = await repository.create({
        ...parsed.data,
        projectId: params.projectId,
        url,
        method: parsed.data.method,
        status: databaseStatus(parsed.data.status),
      });
      return apiJson({ data: serializeMonitor(monitor) }, 201, {
        Location: `/api/projects/${params.projectId}/monitors/${monitor.id}`,
      });
    } catch (error) {
      return apiUnexpected(error, true);
    }
  };

  return { GET, POST };
}

export const monitorCollectionHandlers = createMonitorCollectionHandlers();
