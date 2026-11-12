/**
 * Normalizes the URL segment supplied by Next at the project route boundary.
 * Invalid percent sequences remain literal so rendering stays safe and URL
 * builders can encode them once into a canonical path segment.
 */
export function normalizeProjectId(routeProjectId: string) {
  try {
    return decodeURIComponent(routeProjectId);
  } catch {
    return routeProjectId;
  }
}
