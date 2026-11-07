import { monitorApi } from "../../../../../lib/monitors";

export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return monitorApi.collection.GET(request, await context.params);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return monitorApi.collection.POST(request, await context.params);
}
