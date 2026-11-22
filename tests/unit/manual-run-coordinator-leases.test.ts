import { describe, expect, it } from "vitest";
import {
  MANUAL_RUN_COOLDOWN_MS,
  MANUAL_RUN_LEASE_TTL_MS,
  MANUAL_RUN_PROJECT_CAPACITY,
  createManualRunCoordinator,
  createProductionManualRunCoordinator,
  type RedisScriptClient,
} from "../../apps/web/lib/monitors/run-coordinator.ts";

type LeaseState = {
  now: number;
  leases: Map<string, { owner: string; expiresAt: number }>;
  cooldowns: Map<string, number>;
  projects: Map<string, Map<string, number>>;
};

function timeReply(now: number): readonly [string, string] {
  return [String(Math.floor(now / 1_000)), String((now % 1_000) * 1_000)];
}

function semanticRedis(state: LeaseState): RedisScriptClient {
  return {
    time: async () => timeReply(state.now),
    eval: async (script, keyCount, ...values) => {
      const keys = values.slice(0, keyCount);
      const args = values.slice(keyCount);
      const deadline = Number(args.at(-1));
      if (state.now >= deadline) return ["ADMISSION_EXPIRED"];
      if (script.includes("MANUAL_RUN_ACQUIRE")) {
        const [leaseKey, cooldownKey, projectKey] = keys;
        const [owner, leaseMs, cooldownMs, projectLimit] = args;
        const project = state.projects.get(projectKey) ?? new Map<string, number>();
        for (const [token, expiry] of project) if (expiry <= state.now) project.delete(token);
        state.projects.set(projectKey, project);
        const lease = state.leases.get(leaseKey);
        if (lease && lease.expiresAt > state.now) return ["RUN_IN_PROGRESS"];
        if ((state.cooldowns.get(cooldownKey) ?? 0) > state.now) return ["RUN_COOLDOWN"];
        if (project.size >= Number(projectLimit)) return ["PROJECT_CAPACITY"];
        state.leases.set(leaseKey, { owner, expiresAt: state.now + Number(leaseMs) });
        state.cooldowns.set(cooldownKey, state.now + Number(cooldownMs));
        project.set(owner, state.now + Number(leaseMs));
        return ["ADMITTED"];
      }
      if (script.includes("MANUAL_RUN_RELEASE")) {
        const [leaseKey, projectKey] = keys;
        const [owner] = args;
        const lease = state.leases.get(leaseKey);
        if (lease?.owner === owner) {
          state.leases.delete(leaseKey);
          state.projects.get(projectKey)?.delete(owner);
        }
        return ["ADMITTED"];
      }
      return ["UNKNOWN"];
    },
  };
}

function coordinator(state: LeaseState, tokens = ["owner-a", "owner-b", "owner-c", "owner-d"]) {
  const redis = semanticRedis(state);
  return createManualRunCoordinator({
    getClient: async () => redis,
    monotonicNow: () => state.now,
    ownerToken: () => tokens.shift() ?? "owner-next",
  });
}

describe("manual-run lease coordination", () => {
  it("admits one monitor lease and rejects a concurrent owner", async () => {
    const state: LeaseState = { now: 1_000, leases: new Map(), cooldowns: new Map(), projects: new Map() };
    const run = coordinator(state);
    const first = await run.acquire({ projectId: "p", monitorId: "m" });
    const second = await run.acquire({ projectId: "p", monitorId: "m" });
    expect(first).toEqual({ kind: "admitted", ownerToken: "owner-a" });
    expect(second).toEqual({ kind: "in_progress" });
  });

  it("enforces three concurrent project leases and prunes expired ZSET owners", async () => {
    const state: LeaseState = { now: 1_000, leases: new Map(), cooldowns: new Map(), projects: new Map() };
    const run = coordinator(state);
    await expect(run.acquire({ projectId: "p", monitorId: "m1" })).resolves.toMatchObject({ kind: "admitted" });
    await expect(run.acquire({ projectId: "p", monitorId: "m2" })).resolves.toMatchObject({ kind: "admitted" });
    await expect(run.acquire({ projectId: "p", monitorId: "m3" })).resolves.toMatchObject({ kind: "admitted" });
    await expect(run.acquire({ projectId: "p", monitorId: "m4" })).resolves.toEqual({ kind: "project_capacity" });
    expect([...state.leases.keys()].some((key) => key.includes("m4"))).toBe(false);
    state.now += MANUAL_RUN_COOLDOWN_MS;
    await expect(run.acquire({ projectId: "p", monitorId: "m4" })).resolves.toMatchObject({ kind: "admitted" });
  });

  it("starts cooldown at admission and keeps project keys isolated", async () => {
    const state: LeaseState = { now: 1_000, leases: new Map(), cooldowns: new Map(), projects: new Map() };
    const run = coordinator(state);
    const admitted = await run.acquire({ projectId: "alpha", monitorId: "m" });
    if (admitted.kind !== "admitted") throw new Error("expected admission");
    await run.release({ projectId: "alpha", monitorId: "m", ownerToken: admitted.ownerToken });
    await expect(run.acquire({ projectId: "alpha", monitorId: "m" })).resolves.toEqual({ kind: "cooldown" });
    await expect(run.acquire({ projectId: "beta", monitorId: "m" })).resolves.toMatchObject({ kind: "admitted" });
    state.now += MANUAL_RUN_COOLDOWN_MS - 1;
    await expect(run.acquire({ projectId: "alpha", monitorId: "m" })).resolves.toEqual({ kind: "cooldown" });
    state.now += 1;
    await expect(run.acquire({ projectId: "alpha", monitorId: "m" })).resolves.toMatchObject({ kind: "admitted" });
  });

  it("only releases its own lease, tolerates repeated release, and cannot remove a successor", async () => {
    const state: LeaseState = { now: 1_000, leases: new Map(), cooldowns: new Map(), projects: new Map() };
    const run = coordinator(state, ["old", "successor"]);
    const old = await run.acquire({ projectId: "p", monitorId: "m" });
    if (old.kind !== "admitted") throw new Error("expected admission");
    await run.release({ projectId: "p", monitorId: "m", ownerToken: "wrong" });
    expect(await run.acquire({ projectId: "p", monitorId: "m" })).toEqual({ kind: "in_progress" });
    state.now += MANUAL_RUN_COOLDOWN_MS;
    const successor = await run.acquire({ projectId: "p", monitorId: "m" });
    if (successor.kind !== "admitted") throw new Error("expected successor");
    await run.release({ projectId: "p", monitorId: "m", ownerToken: old.ownerToken });
    expect(await run.acquire({ projectId: "p", monitorId: "m" })).toEqual({ kind: "in_progress" });
    await expect(run.release({ projectId: "p", monitorId: "m", ownerToken: successor.ownerToken })).resolves.toEqual({ kind: "released" });
    await expect(run.release({ projectId: "p", monitorId: "m", ownerToken: successor.ownerToken })).resolves.toEqual({ kind: "released" });
  });

  it("fails closed when admission cannot obtain a Redis client", async () => {
    const run = createManualRunCoordinator({ getClient: async () => { throw new Error("redis unavailable"); } });
    await expect(run.acquire({ projectId: "p", monitorId: "m" })).resolves.toEqual({ kind: "unavailable" });
  });

  it("keeps the production coordinator fail-closed without an in-memory fallback", async () => {
    const run = createProductionManualRunCoordinator({ redisUrl: undefined });
    await expect(run.acquire({ projectId: "p", monitorId: "m" })).resolves.toEqual({ kind: "unavailable" });
  });
});
