import { createMonitorActionHandlers } from "./actions";
import { createMonitorCollectionHandlers } from "./collection";
import { createMonitorItemHandlers } from "./item";
import type { MonitorApiOptions } from "./http";

/** Build the complete monitor API with one shared repository and DNS resolver. */
export function createMonitorApi(options: MonitorApiOptions = {}) {
  return {
    collection: createMonitorCollectionHandlers(options),
    item: createMonitorItemHandlers(options),
    actions: createMonitorActionHandlers(options),
  };
}

export const monitorApi = createMonitorApi();

export { createMonitorApiDependencies } from "./http";
export type { MonitorApiOptions, MonitorRepository, MonitorRecord } from "./http";
