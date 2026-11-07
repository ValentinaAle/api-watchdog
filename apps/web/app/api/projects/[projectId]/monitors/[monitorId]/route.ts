import { monitorApi } from "../../../../../../lib/monitors";

export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; monitorId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return monitorApi.item.GET(request, await context.params);
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return monitorApi.item.PATCH(request, await context.params);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return monitorApi.item.DELETE(request, await context.params);
}
