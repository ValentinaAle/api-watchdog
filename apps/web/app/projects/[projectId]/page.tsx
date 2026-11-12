import { Dashboard } from "../../../components/dashboard/dashboard";
import { AppShell } from "../../../components/shell/app-shell";

type PageProps = { params: Promise<{ projectId: string }> };

export default async function ProjectDashboardPage({ params }: PageProps) {
  const { projectId: encodedProjectId } = await params;
  const projectId = decodeURIComponent(encodedProjectId);

  return (
    <AppShell projectId={projectId}>
      <Dashboard projectId={projectId} />
    </AppShell>
  );
}
