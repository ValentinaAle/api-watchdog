import { MonitorDetail } from "../../../../../components/monitors/monitor-detail";

type PageProps = { params: Promise<{ projectId: string; monitorId: string }> };

export default async function MonitorDetailsPage({ params }: PageProps) {
  const { projectId, monitorId } = await params;
  return <MonitorDetail projectId={projectId} monitorId={monitorId} />;
}
