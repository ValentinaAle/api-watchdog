import { MonitorList } from "../../../../components/monitors/monitor-list";

type PageProps = { params: Promise<{ projectId: string }> };

export default async function ProjectMonitorsPage({ params }: PageProps) {
  const { projectId } = await params;
  return <MonitorList projectId={projectId} />;
}
