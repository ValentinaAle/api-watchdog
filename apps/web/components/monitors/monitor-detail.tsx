"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatDate, formatInterval, monitorActionApiPath, monitorApiPath, projectMonitorsPath, readApiError, type Monitor } from "./types";

export function MonitorDetail({ projectId, monitorId }: { projectId: string; monitorId: string }) {
  const router = useRouter();
  const [monitor, setMonitor] = useState<Monitor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const base = projectMonitorsPath(projectId);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(monitorApiPath(projectId, monitorId), { cache: "no-store" });
      if (!response.ok) {
        const problem = await readApiError(response);
        setError(problem?.code === "MONITOR_NOT_FOUND" ? "This monitor was not found in this project." : problem?.message ?? "Monitor could not be loaded.");
        setMonitor(null);
        return;
      }
      const { data } = await response.json() as { data: Monitor };
      setMonitor(data);
    } catch {
      setError("We could not reach the monitor service. Try again.");
      setMonitor(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, monitorId]);

  useEffect(() => { void load(); }, [load]);

  async function changeStatus() {
    if (!monitor) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const action = monitor.status === "active" ? "pause" : "resume";
      const response = await fetch(monitorActionApiPath(projectId, monitorId, action), { method: "POST" });
      if (!response.ok) {
        const problem = await readApiError(response);
        setError(problem?.message ?? "Status could not be changed.");
        return;
      }
      const { data } = await response.json() as { data: Monitor };
      setMonitor(data);
      setNotice(data.status === "paused" ? "Monitor paused." : "Monitor resumed.");
    } catch {
      setError("We could not reach the monitor service. Status was not changed.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteMonitor() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(monitorApiPath(projectId, monitorId), { method: "DELETE" });
      if (response.status !== 204) {
        const problem = await readApiError(response);
        setError(problem?.message ?? "Monitor could not be deleted.");
        setConfirmDelete(false);
        return;
      }
      router.push(base);
      router.refresh();
    } catch {
      setError("We could not reach the monitor service. The monitor was not deleted.");
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  return <main className="mx-auto min-h-screen w-full max-w-4xl px-4 pb-16 pt-7 sm:px-8 sm:pt-12">
    <header className="mb-8 flex items-center justify-between gap-4 border-b border-slate-700/70 pb-5"><div className="flex items-center gap-3"><a aria-label="Back to monitors" className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-slate-700 text-lg text-slate-300 hover:border-cyan-300 hover:text-cyan-200" href={base}>←</a><div><p className="text-xs font-bold tracking-[0.24em] text-cyan-300">API WATCHDOG</p><p className="mt-1 text-sm text-slate-400">Monitor details</p></div></div>{monitor ? <a className="rounded-lg border border-slate-700 px-4 py-3 text-sm font-semibold text-slate-200 hover:border-cyan-300 hover:text-cyan-200" href={`${base}/${encodeURIComponent(monitorId)}/edit`}>Edit</a> : null}</header>
    {loading ? <div role="status" className="rounded-xl border border-slate-700 bg-slate-900/70 p-5 text-slate-300">Loading monitor…</div> : null}
    {!loading && error && !monitor ? <section role="alert" className="rounded-2xl border border-slate-700 bg-slate-900/70 p-6"><h1 className="text-xl font-semibold text-slate-50">Monitor unavailable</h1><p className="mt-2 text-sm text-slate-300">{error}</p><div className="mt-5 flex gap-3"><button onClick={() => void load()} className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">Try again</button><a className="rounded-lg px-4 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-200/10" href={base}>Back to monitors</a></div></section> : null}
    {monitor ? <>
      <section className="rounded-2xl border border-cyan-300/20 bg-gradient-to-br from-cyan-300/10 to-slate-900/80 p-5 sm:p-8"><div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><p className="font-mono text-xs uppercase tracking-[0.18em] text-cyan-200">MONITOR STATUS</p><h1 className="mt-3 break-words text-3xl font-semibold text-slate-50">{monitor.name}</h1></div><span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wide ${monitor.status === "active" ? "bg-emerald-400/10 text-emerald-200" : "bg-slate-500/20 text-slate-300"}`}><span aria-hidden="true" className={`h-2 w-2 rounded-full ${monitor.status === "active" ? "bg-emerald-300" : "bg-slate-400"}`} />{monitor.status}</span></div><p className="mt-5 break-all font-mono text-sm leading-6 text-slate-300">{monitor.method} <span className="text-cyan-100">{monitor.url}</span></p><div className="mt-6 flex flex-col gap-3 sm:flex-row"><button onClick={() => void changeStatus()} disabled={busy} className="min-h-11 rounded-lg bg-cyan-300 px-5 py-3 text-sm font-bold text-slate-950 hover:bg-cyan-200 disabled:opacity-60">{busy ? "Saving…" : monitor.status === "active" ? "Pause monitor" : "Resume monitor"}</button><button onClick={() => setConfirmDelete(true)} disabled={busy} className="min-h-11 rounded-lg border border-rose-300/40 px-5 py-3 text-sm font-semibold text-rose-200 hover:bg-rose-300/10 disabled:opacity-60">Delete</button></div></section>
      {notice ? <p role="status" className="mt-4 rounded-lg border border-emerald-300/20 bg-emerald-300/5 p-3 text-sm text-emerald-200">{notice}</p> : null}
      {error ? <p role="alert" className="mt-4 rounded-lg border border-rose-300/30 bg-rose-950/30 p-3 text-sm text-rose-100">{error}</p> : null}
      <section className="mt-6 rounded-2xl border border-slate-700/80 bg-slate-900/70 p-5 sm:p-7"><h2 className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">Request configuration</h2><dl className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-2"><div><dt className="text-xs text-slate-500">HTTP method</dt><dd className="mt-1 font-mono text-sm text-slate-100">{monitor.method}</dd></div><div><dt className="text-xs text-slate-500">Expected status</dt><dd className="mt-1 font-mono text-sm text-slate-100">{monitor.expectedStatus}</dd></div><div><dt className="text-xs text-slate-500">Interval</dt><dd className="mt-1 text-sm text-slate-100">{formatInterval(monitor.intervalSeconds)}</dd></div><div><dt className="text-xs text-slate-500">Timeout</dt><dd className="mt-1 text-sm text-slate-100">{monitor.timeoutMs.toLocaleString()} ms</dd></div><div><dt className="text-xs text-slate-500">Created</dt><dd className="mt-1 text-sm text-slate-100">{formatDate(monitor.createdAt)}</dd></div><div><dt className="text-xs text-slate-500">Last updated</dt><dd className="mt-1 text-sm text-slate-100">{formatDate(monitor.updatedAt)}</dd></div></dl></section>
      <p className="mt-5 text-xs leading-5 text-slate-500">This page manages saved configuration only. It does not run a check or display monitoring history.</p>
    </> : null}
    {confirmDelete && monitor ? <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4" role="presentation"><section aria-labelledby="delete-title" aria-describedby="delete-description" aria-modal="true" className="w-full max-w-md rounded-2xl border border-rose-300/30 bg-slate-900 p-6 shadow-2xl" role="alertdialog"><p className="font-mono text-xs font-bold uppercase tracking-[0.18em] text-rose-200">Permanent action</p><h2 id="delete-title" className="mt-3 text-xl font-semibold text-slate-50">Delete {monitor.name}?</h2><p id="delete-description" className="mt-3 text-sm leading-6 text-slate-300">This permanently removes this monitor configuration. This action cannot be undone.</p><div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><button autoFocus onClick={() => setConfirmDelete(false)} disabled={busy} className="min-h-11 rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">Cancel</button><button onClick={() => void deleteMonitor()} disabled={busy} className="min-h-11 rounded-lg bg-rose-400 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-rose-300 disabled:opacity-60">{busy ? "Deleting…" : "Delete monitor"}</button></div></section></div> : null}
  </main>;
}
