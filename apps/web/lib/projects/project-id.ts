/**
 * Normalizes the URL segment supplied by Next at the project route boundary.
 * Invalid percent sequences and template placeholders are rejected by the
 * route boundary before any URL builders receive an ID.
 */
export function normalizeProjectId(routeProjectId: string): string | undefined {
  try {
    const normalizedProjectId = decodeURIComponent(routeProjectId);

    if (isProjectIdPlaceholder(routeProjectId) || isProjectIdPlaceholder(normalizedProjectId)) {
      return undefined;
    }

    return normalizedProjectId;
  } catch {
    return undefined;
  }
}

function isProjectIdPlaceholder(projectId: string) {
  return projectId === "{projectId}" || /^%7BprojectId%7D$/i.test(projectId);
}
