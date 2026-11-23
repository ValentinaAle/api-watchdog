import { manualRunHandlers } from "../../../../../../../lib/monitors/run";

export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; monitorId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return manualRunHandlers.POST(request, await context.params);
}
