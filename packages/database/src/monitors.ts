import type { HttpMethod, Monitor, MonitorStatus, Prisma } from "@prisma/client";
import { prisma } from "./index.js";

export type MonitorInput = {
  projectId: string;
  name: string;
  url: string;
  method: HttpMethod;
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: number;
  status: MonitorStatus;
};

export type MonitorUpdate = Partial<Omit<MonitorInput, "projectId">>;

const scheduleFields = [
  "url",
  "method",
  "intervalSeconds",
  "timeoutMs",
  "expectedStatus",
  "status",
] as const;

const maxUpdateAttempts = 5;

function changesSchedule(current: Monitor, input: MonitorUpdate): boolean {
  return scheduleFields.some((field) => input[field] !== undefined && input[field] !== current[field]);
}

export function createMonitor(input: MonitorInput): Promise<Monitor> {
  const { projectId, ...data } = input;
  return prisma.monitor.create({ data: { ...data, project: { connect: { id: projectId } } } });
}

export function listMonitors(projectId: string): Promise<Monitor[]> {
  return prisma.monitor.findMany({
    where: { projectId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

export function getMonitor(projectId: string, monitorId: string): Promise<Monitor | null> {
  return prisma.monitor.findFirst({ where: { id: monitorId, projectId } });
}

export async function updateMonitor(
  projectId: string,
  monitorId: string,
  input: MonitorUpdate,
): Promise<Monitor | null> {
  for (let attempt = 0; attempt < maxUpdateAttempts; attempt += 1) {
    const current = await getMonitor(projectId, monitorId);
    if (!current) return null;

    const updatesSchedule = changesSchedule(current, input);
    const data: Prisma.MonitorUpdateManyMutationInput = updatesSchedule
      ? { ...input, scheduleVersion: { increment: 1 } }
      : input;
    const result = await prisma.monitor.updateMany({
      where: updatesSchedule
        ? { id: monitorId, projectId, scheduleVersion: current.scheduleVersion }
        : { id: monitorId, projectId },
      data,
    });

    if (result.count > 0) return getMonitor(projectId, monitorId);
  }

  throw new Error("Monitor update contention");
}

export async function deleteMonitor(projectId: string, monitorId: string): Promise<boolean> {
  const result = await prisma.monitor.deleteMany({ where: { id: monitorId, projectId } });
  return result.count > 0;
}
