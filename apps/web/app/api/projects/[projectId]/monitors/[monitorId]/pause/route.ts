import { monitorApi } from "../../../../../../../lib/monitors";

export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; monitorId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return monitorApi.actions.pause(request, await context.params);
}
