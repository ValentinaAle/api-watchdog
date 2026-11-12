"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { ProjectIdProvider } from "../projects/project-context";
import { projectDashboardPath, projectMonitorsPath } from "../../lib/projects/paths";

type AppShellProps = {
  children: ReactNode;
  projectId?: string;
};

export function AppShell({ children, projectId }: AppShellProps) {
  const pathname = usePathname();
  const dashboardHref = projectId ? projectDashboardPath(projectId) : "/";
  const monitorsHref = projectId ? projectMonitorsPath(projectId) : undefined;
  const dashboardCurrent = pathname === dashboardHref;
  const monitorsCurrent = Boolean(monitorsHref && (pathname === monitorsHref || pathname.startsWith(`${monitorsHref}/`)));

  return (
    <ProjectIdProvider projectId={projectId}>
      <div className="app-shell">
      <a className="app-shell__skip-link" href="#main-content">
        Saltar al contenido principal
      </a>
      <aside className="app-shell__sidebar">
        <a className="app-shell__brand" href={dashboardHref}>
          API WATCHDOG
        </a>
        <nav className="app-shell__nav" aria-label="Navegación principal">
          <a
            className="app-shell__nav-link"
            href={dashboardHref}
            aria-current={dashboardCurrent ? "page" : undefined}
          >
            Dashboard
          </a>
          {monitorsHref ? (
            <a className="app-shell__nav-link" href={monitorsHref} aria-current={monitorsCurrent ? "page" : undefined}>
              Monitores
            </a>
          ) : (
            <span className="app-shell__nav-unavailable" aria-disabled="true">
              Monitores
              <span className="app-shell__nav-note">Requiere contexto de proyecto</span>
            </span>
          )}
        </nav>
      </aside>
      <div className="app-shell__workspace">
        <header className="app-shell__topbar">
          {projectId ? "Dashboard del proyecto" : "Contexto del proyecto no disponible"}
        </header>
        <main className="app-shell__content" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
      </div>
    </ProjectIdProvider>
  );
}
