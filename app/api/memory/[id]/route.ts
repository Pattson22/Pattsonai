import { deleteMemoryById } from "@/lib/db";

export async function DELETE(_req: Request, ctx: RouteContext<"/api/memory/[id]">) {
  const { id } = await ctx.params;
  const numericId = Number(id);

  if (!Number.isInteger(numericId)) {
    return new Response("Invalid memory id", { status: 400 });
  }

  const removed = deleteMemoryById(numericId);
  if (!removed) {
    return new Response("Memory not found", { status: 404 });
  }

  return Response.json({ removed: true });
}
