import { MonitorForm } from "../../../../../../components/monitors/monitor-form";

type PageProps = { params: Promise<{ projectId: string; monitorId: string }> };

export default async function EditMonitorPage({ params }: PageProps) {
  const { projectId, monitorId } = await params;
  return <MonitorForm projectId={projectId} monitorId={monitorId} />;
}
