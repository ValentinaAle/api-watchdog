import { MonitorForm } from "../../../../../../components/monitors/monitor-form";

type PageProps = { params: Promise<{ monitorId: string }> };

export default async function EditMonitorPage({ params }: PageProps) {
  const { monitorId } = await params;
  return <MonitorForm monitorId={monitorId} />;
}
