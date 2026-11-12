import { MonitorDetail } from "../../../../../components/monitors/monitor-detail";

type PageProps = { params: Promise<{ monitorId: string }> };

export default async function MonitorDetailsPage({ params }: PageProps) {
  const { monitorId } = await params;
  return <MonitorDetail monitorId={monitorId} />;
}
