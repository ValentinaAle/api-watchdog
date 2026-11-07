"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { monitorApiPath, projectMonitorsPath, readApiError, type Monitor } from "./types";

type Props = { projectId: string; monitorId?: string };
type FormValues = { name: string; url: string; method: Monitor["method"]; intervalSeconds: string; timeoutMs: string; expectedStatus: string; status: Monitor["status"] };
const initial: FormValues = { name: "", url: "", method: "GET", intervalSeconds: "60", timeoutMs: "5000", expectedStatus: "200", status: "active" };
const methods: Monitor["method"][] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block"><span className="text-sm font-medium text-slate-200">{label}</span>{children}{hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}</label>;
}

const inputClass = "mt-2 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/20";

export function MonitorForm({ projectId, monitorId }: Props) {
  const router = useRouter();
  const editing = Boolean(monitorId);
  const [values, setValues] = useState<FormValues>(initial);
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!monitorId) return;
    let current = true;
    void fetch(monitorApiPath(projectId, monitorId), { cache: "no-store" }).then(async (response) => {
      if (!current) return;
      if (!response.ok) {
        const problem = await readApiError(response);
        setError(problem?.code === "MONITOR_NOT_FOUND" ? "This monitor was not found in this project." : problem?.message ?? "Monitor could not be loaded.");
        return;
      }
      const { data } = await response.json() as { data: Monitor };
      if (current) setValues({ name: data.name, url: data.url, method: data.method, intervalSeconds: String(data.intervalSeconds), timeoutMs: String(data.timeoutMs), expectedStatus: String(data.expectedStatus), status: data.status });
    }).catch(() => { if (current) setError("We could not reach the monitor service. Try again."); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [projectId, monitorId]);

  function update<Key extends keyof FormValues>(key: Key, value: FormValues[Key]) {
    setValues((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => ({ ...current, [key]: "" }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});
    const payload = {
      name: values.name,
      url: values.url,
      method: values.method,
      intervalSeconds: Number(values.intervalSeconds),
      timeoutMs: Number(values.timeoutMs),
      expectedStatus: Number(values.expectedStatus),
      ...(!editing ? { status: values.status } : {}),
    };
    try {
      const response = await fetch(monitorApiPath(projectId, monitorId), {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const problem = await readApiError(response);
        const issues = problem?.issues ?? [];
        const mapped = Object.fromEntries(issues.flatMap((issue) => issue.path?.length ? [[issue.path[0]!, issue.message ?? "Invalid value"]] : []));
        setFieldErrors(mapped);
        setError(problem?.message ?? "Monitor could not be saved.");
        return;
      }
      const { data } = await response.json() as { data: Monitor };
      router.push(`${projectMonitorsPath(projectId)}/${encodeURIComponent(data.id)}`);
      router.refresh();
    } catch {
      setError("We could not reach the monitor service. Your changes were not saved.");
    } finally {
      setSaving(false);
    }
  }

  return <main className="mx-auto min-h-screen w-full max-w-3xl px-4 pb-16 pt-7 sm:px-8 sm:pt-12">
    <header className="mb-8 flex items-center gap-4 border-b border-slate-700/70 pb-5"><a aria-label="Back to monitors" className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-slate-700 text-lg text-slate-300 hover:border-cyan-300 hover:text-cyan-200" href={projectMonitorsPath(projectId)}>←</a><div><p className="text-xs font-bold tracking-[0.24em] text-cyan-300">API WATCHDOG</p><p className="mt-1 text-sm text-slate-400">Project monitors</p></div></header>
    <div className="mb-7"><p className="font-mono text-xs uppercase tracking-[0.2em] text-cyan-300">CONFIGURATION</p><h1 className="mt-2 text-3xl font-semibold text-slate-50">{editing ? "Edit monitor" : "Create monitor"}</h1><p className="mt-2 text-sm text-slate-400">Save endpoint settings for this project.</p></div>
    {loading ? <div role="status" className="rounded-xl border border-slate-700 bg-slate-900/70 p-5 text-slate-300">Loading monitor…</div> : null}
    {!loading && error && editing && !values.name ? <div role="alert" className="rounded-xl border border-rose-400/30 bg-rose-950/30 p-5 text-rose-100"><p>{error}</p><a className="mt-4 inline-block text-sm font-semibold underline" href={projectMonitorsPath(projectId)}>Back to monitors</a></div> : null}
    {!loading && (!editing || values.name) ? <form className="space-y-5" onSubmit={submit} noValidate>
      <section className="rounded-2xl border border-slate-700/80 bg-slate-900/70 p-5 sm:p-7"><h2 className="mb-5 text-xs font-bold uppercase tracking-[0.18em] text-slate-400">General settings</h2><div className="space-y-5">
        <Field label="Monitor name"><input className={inputClass} value={values.name} maxLength={100} required autoComplete="off" placeholder="Production API" onChange={(event) => update("name", event.target.value)} aria-invalid={Boolean(fieldErrors.name)} />{fieldErrors.name ? <span className="mt-1 block text-sm text-rose-300">{fieldErrors.name}</span> : null}</Field>
        <Field label="Endpoint URL" hint="Only public HTTP or HTTPS endpoints are allowed. Saving a URL does not run a check."><input className={`${inputClass} font-mono`} type="url" value={values.url} required autoComplete="url" placeholder="https://api.example.com/health" onChange={(event) => update("url", event.target.value)} aria-invalid={Boolean(fieldErrors.url)} />{fieldErrors.url ? <span className="mt-1 block text-sm text-rose-300">{fieldErrors.url}</span> : null}</Field>
      </div></section>
      <section className="rounded-2xl border border-slate-700/80 bg-slate-900/70 p-5 sm:p-7"><h2 className="mb-5 text-xs font-bold uppercase tracking-[0.18em] text-slate-400">Request configuration</h2><div className="grid gap-5 sm:grid-cols-2">
        <Field label="HTTP method"><select className={inputClass} value={values.method} onChange={(event) => update("method", event.target.value as Monitor["method"])}>{methods.map((method) => <option key={method}>{method}</option>)}</select></Field>
        <Field label="Expected status" hint="HTTP status code, 100–599"><input className={inputClass} type="number" min={100} max={599} step={1} required value={values.expectedStatus} onChange={(event) => update("expectedStatus", event.target.value)} aria-invalid={Boolean(fieldErrors.expectedStatus)} />{fieldErrors.expectedStatus ? <span className="mt-1 block text-sm text-rose-300">{fieldErrors.expectedStatus}</span> : null}</Field>
      </div></section>
      <section className="rounded-2xl border border-slate-700/80 bg-slate-900/70 p-5 sm:p-7"><h2 className="mb-5 text-xs font-bold uppercase tracking-[0.18em] text-slate-400">Frequency &amp; timeout</h2><div className="grid gap-5 sm:grid-cols-2">
        <Field label="Interval (seconds)" hint="30–86,400 seconds"><input className={inputClass} type="number" min={30} max={86400} step={1} required value={values.intervalSeconds} onChange={(event) => update("intervalSeconds", event.target.value)} aria-invalid={Boolean(fieldErrors.intervalSeconds)} />{fieldErrors.intervalSeconds ? <span className="mt-1 block text-sm text-rose-300">{fieldErrors.intervalSeconds}</span> : null}</Field>
        <Field label="Timeout (milliseconds)" hint="1,000–60,000 ms"><input className={inputClass} type="number" min={1000} max={60000} step={1} required value={values.timeoutMs} onChange={(event) => update("timeoutMs", event.target.value)} aria-invalid={Boolean(fieldErrors.timeoutMs)} />{fieldErrors.timeoutMs ? <span className="mt-1 block text-sm text-rose-300">{fieldErrors.timeoutMs}</span> : null}</Field>
      </div></section>
      {!editing ? <section className="rounded-2xl border border-slate-700/80 bg-slate-900/70 p-5 sm:p-7"><h2 className="mb-4 text-xs font-bold uppercase tracking-[0.18em] text-slate-400">Initial status</h2><Field label="Monitor status"><select className={inputClass} value={values.status} onChange={(event) => update("status", event.target.value as Monitor["status"])}><option value="active">Active</option><option value="paused">Paused</option></select></Field></section> : <p className="rounded-xl border border-slate-700/60 bg-slate-900/40 p-4 text-sm leading-6 text-slate-400">Status is managed separately from configuration. Use the pause or resume action from monitor details.</p>}
      {error ? <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-950/30 p-4 text-sm text-rose-200">{error}</p> : null}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><a className="inline-flex min-h-12 items-center justify-center rounded-lg border border-slate-700 px-5 py-3 text-sm font-semibold text-slate-300 hover:bg-slate-800" href={projectMonitorsPath(projectId)}>Cancel</a><button disabled={saving} className="min-h-12 rounded-lg bg-cyan-300 px-6 py-3 text-sm font-bold text-slate-950 hover:bg-cyan-200 disabled:cursor-wait disabled:opacity-60" type="submit">{saving ? "Saving…" : editing ? "Save changes" : "Create monitor"}</button></div>
    </form> : null}
  </main>;
}
