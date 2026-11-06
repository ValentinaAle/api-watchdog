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
  const data: Prisma.MonitorUpdateManyMutationInput = input;
  const result = await prisma.monitor.updateMany({
    where: { id: monitorId, projectId },
    data,
  });

  if (result.count === 0) return null;
  return getMonitor(projectId, monitorId);
}

export async function deleteMonitor(projectId: string, monitorId: string): Promise<boolean> {
  const result = await prisma.monitor.deleteMany({ where: { id: monitorId, projectId } });
  return result.count > 0;
}
