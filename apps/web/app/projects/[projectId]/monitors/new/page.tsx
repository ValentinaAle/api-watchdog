import { MonitorForm } from "../../../../../components/monitors/monitor-form";

type PageProps = { params: Promise<{ projectId: string }> };

export default async function NewMonitorPage({ params }: PageProps) {
  const { projectId } = await params;
  return <MonitorForm projectId={projectId} />;
}
