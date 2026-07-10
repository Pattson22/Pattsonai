import { countMemories } from "@/lib/db";

export async function GET() {
  return Response.json({ count: countMemories() });
}
