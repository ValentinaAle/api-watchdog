export function projectDashboardPath(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export function projectMonitorsPath(projectId: string) {
  return `${projectDashboardPath(projectId)}/monitors`;
}

export function projectNewMonitorPath(projectId: string) {
  return `${projectMonitorsPath(projectId)}/new`;
}

export function projectMonitorPath(projectId: string, monitorId: string) {
  return `${projectMonitorsPath(projectId)}/${encodeURIComponent(monitorId)}`;
}

export function projectMonitorEditPath(projectId: string, monitorId: string) {
  return `${projectMonitorPath(projectId, monitorId)}/edit`;
}
