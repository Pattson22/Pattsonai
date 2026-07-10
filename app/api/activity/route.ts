import { getRecentActivity } from "@/lib/db";

export async function GET() {
  return Response.json(getRecentActivity(20));
}
