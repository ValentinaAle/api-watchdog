import {
  apiFailure,
  apiJson,
  apiPathError,
  apiUnexpected,
  createMonitorApiDependencies,
  serializeMonitor,
  type Handler,
  type MonitorApiOptions,
  type MonitorParams,
  type MonitorStatus,
} from "./http";

export function createMonitorActionHandlers(options: MonitorApiOptions = {}) {
  const { repository } = createMonitorApiDependencies(options);
  const setStatus = (status: MonitorStatus): Handler<MonitorParams> => async (_request, params) => {
    const invalid = apiPathError(params);
    if (invalid) return invalid;
    try {
      const monitor = await repository.update(params.projectId, params.monitorId, { status });
      return monitor ? apiJson({ data: serializeMonitor(monitor) })
        : apiFailure("MONITOR_NOT_FOUND", "Monitor not found", 404);
    } catch (error) {
      return apiUnexpected(error);
    }
  };

  return { pause: setStatus("PAUSED"), resume: setStatus("ACTIVE") };
}

export const monitorActionHandlers = createMonitorActionHandlers();
