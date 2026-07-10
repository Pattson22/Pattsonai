import { countMemories, getAllMemories } from "@/lib/db";

export async function GET() {
  const memories = getAllMemories();
  return Response.json({ count: countMemories(), memories });
}
