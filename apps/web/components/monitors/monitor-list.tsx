"use client";

import { useCallback, useEffect, useState } from "react";
import { projectMonitorPath, projectMonitorsPath, projectNewMonitorPath } from "../../lib/projects/paths";
import { useProjectId } from "../projects/project-context";
import { formatInterval, monitorApiPath, readApiError, type Monitor } from "./types";

function StatusPill({ status }: { status: Monitor["status"] }) {
  return <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${status === "active" ? "bg-emerald-400/10 text-emerald-300" : "bg-slate-500/20 text-slate-300"}`}>
    <span aria-hidden="true" className={`h-2 w-2 rounded-full ${status === "active" ? "bg-emerald-300" : "bg-slate-400"}`} />{status}
  </span>;
}

export function MonitorList({ projectId: suppliedProjectId }: { projectId?: string }) {
  const contextProjectId = useProjectId();
  const routeProjectId = suppliedProjectId ?? contextProjectId;
  if (!routeProjectId) throw new Error("MonitorList requires project context.");
  const projectId: string = routeProjectId;
  const [monitors, setMonitors] = useState<Monitor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(monitorApiPath(projectId), { cache: "no-store" });
      if (!response.ok) {
        const problem = await readApiError(response);
        setError(problem?.code === "PROJECT_NOT_FOUND" ? "This project was not found." : problem?.message ?? "Monitors could not be loaded.");
        setMonitors(null);
        return;
      }
      const result = await response.json() as { data: Monitor[] };
      setMonitors(result.data);
    } catch {
      setMonitors(null);
      setError("We could not reach the monitor service. Try again.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  const base = projectMonitorsPath(projectId);

  return <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-7 sm:px-8 sm:pt-12">
    <header className="mb-8 flex items-center justify-between gap-4 border-b border-slate-700/70 pb-5">
      <div><p className="text-sm text-slate-400">Project monitors</p></div>
      <a className="min-h-11 rounded-lg bg-cyan-300 px-4 py-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200" href={projectNewMonitorPath(projectId)}>＋ <span className="hidden sm:inline">Create monitor</span><span className="sm:hidden">Create</span></a>
    </header>
    <section aria-labelledby="monitor-heading">
      <div className="mb-6"><p className="font-mono text-xs uppercase tracking-[0.2em] text-cyan-300">MONITORING</p><h1 id="monitor-heading" className="mt-2 text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl">Monitors</h1><p className="mt-2 text-sm text-slate-400">Manage endpoints for this project.</p></div>
      {loading && monitors === null && !error ? <div role="status" className="rounded-2xl border border-slate-700 bg-slate-900/70 p-6 text-slate-300">Loading monitors…</div> : null}
      {error ? <div role="alert" className="rounded-2xl border border-rose-400/30 bg-rose-950/30 p-5"><p className="font-medium text-rose-200">{error}</p><button className="mt-4 rounded-lg border border-rose-200/30 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-200/10" onClick={() => void load()} disabled={loading}>{loading ? "Retrying…" : "Try again"}</button></div> : null}
      {monitors?.length === 0 ? <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-8 text-center sm:p-12"><span aria-hidden="true" className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-cyan-300/10 text-2xl text-cyan-200">⌁</span><h2 className="mt-4 text-xl font-semibold text-slate-50">No monitors yet</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-400">Add an endpoint to save its monitoring configuration to this project.</p><a className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-cyan-300 px-4 py-3 text-sm font-bold text-slate-950 hover:bg-cyan-200" href={projectNewMonitorPath(projectId)}>Create your first monitor</a></div> : null}
      {monitors && monitors.length > 0 ? <ul className="grid gap-4 sm:grid-cols-2">{monitors.map((monitor) => <li key={monitor.id} className="rounded-2xl border border-slate-700/80 bg-slate-900/75 p-5 shadow-[0_12px_40px_rgba(0,0,0,.18)] sm:p-6">
        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate text-lg font-semibold text-slate-50"><a className="hover:text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-200" href={projectMonitorPath(projectId, monitor.id)}>{monitor.name}</a></h2><p className="mt-2 break-all font-mono text-xs leading-5 text-slate-400">{monitor.method} <span className="text-cyan-200">{monitor.url}</span></p></div><StatusPill status={monitor.status} /></div>
        <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-slate-700/70 pt-4 text-sm"><div><dt className="text-xs text-slate-500">Interval</dt><dd className="mt-1 text-slate-200">{formatInterval(monitor.intervalSeconds)}</dd></div><div><dt className="text-xs text-slate-500">Expected status</dt><dd className="mt-1 font-mono text-slate-200">{monitor.expectedStatus}</dd></div></dl>
        <div className="mt-5 flex justify-end"><a className="rounded-lg px-3 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-200/10" href={projectMonitorPath(projectId, monitor.id)}>View details <span aria-hidden="true">→</span></a></div>
      </li>)}</ul> : null}
    </section>
    <footer className="mt-12 border-t border-slate-800 pt-4 text-xs text-slate-500">Project ID <span className="font-mono">{projectId}</span></footer>
  </div>;
}
