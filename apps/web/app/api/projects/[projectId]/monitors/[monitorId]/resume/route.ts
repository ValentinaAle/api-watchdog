import { monitorApi } from "../../../../../../../lib/monitors";

export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; monitorId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return monitorApi.actions.resume(request, await context.params);
}
