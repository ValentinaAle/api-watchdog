import { monitorCollectionHandlers } from "../../../../../lib/monitors/collection";

export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return monitorCollectionHandlers.GET(request, await context.params);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return monitorCollectionHandlers.POST(request, await context.params);
}
