type DashboardProps = { projectId?: string };

export function Dashboard({ projectId }: DashboardProps) {
  if (!projectId) {
    return (
      <>
        <h1>Dashboard</h1>
        <section className="app-shell__empty-state" aria-labelledby="context-title">
          <h2 id="context-title">No project context</h2>
          <p>
            A project has not been selected for this page. Open a project-specific
            dashboard to view project information.
          </p>
        </section>
      </>
    );
  }

  return (
    <div className="dashboard" aria-labelledby="dashboard-title">
      <div className="dashboard__heading">
        <div>
          <p className="dashboard__eyebrow">Project dashboard</p>
          <h1 id="dashboard-title">Dashboard</h1>
        </div>
        <p className="dashboard__project">Project ID: <span>{projectId}</span></p>
      </div>

      <p className="dashboard__notice" role="status">
        Dashboard monitoring data is unavailable. No operational results are shown.
      </p>

      <section className="dashboard__metrics" aria-label="Unavailable dashboard data">
        <article className="dashboard__card">
          <h2>Check status</h2>
          <p className="dashboard__unavailable">Unavailable</p>
          <p>Monitoring results are not available.</p>
        </article>
        <article className="dashboard__card">
          <h2>Incidents</h2>
          <p className="dashboard__unavailable">Unavailable</p>
          <p>Incident data is not available.</p>
        </article>
      </section>

      <section className="dashboard__sections" aria-label="Dashboard details">
        <article className="dashboard__card">
          <h2>Monitor status</h2>
          <p>No monitor status data is available.</p>
        </article>
        <article className="dashboard__card">
          <h2>Activity</h2>
          <p>No activity data is available.</p>
        </article>
      </section>
    </div>
  );
}
