export function projectDashboardPath(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}`;
}
