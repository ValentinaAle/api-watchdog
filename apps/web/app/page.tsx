import { AppShell } from "../components/shell/app-shell";

export default function HomePage() {
  return (
    <AppShell>
      <h1>Dashboard</h1>
      <section className="app-shell__empty-state" aria-labelledby="context-title">
        <h2 id="context-title">No project context</h2>
        <p>
          A project has not been selected for this page. Open a project-specific
          dashboard to view project information.
        </p>
      </section>
    </AppShell>
  );
}
