export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-24">
      <p className="text-sm font-semibold tracking-[0.24em] text-cyan-300">API WATCHDOG</p>
      <h1 className="mt-4 text-5xl font-bold">Foundation is running.</h1>
      <p className="mt-6 text-lg text-slate-300">Web, PostgreSQL, Redis, BullMQ workers, and local mail are ready for the next milestone.</p>
      <a className="mt-8 inline-block rounded bg-cyan-400 px-4 py-2 font-semibold text-slate-950" href="/api/health">Check health</a>
    </main>
  );
}
