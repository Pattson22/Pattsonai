import { streamAssistantReply } from "@/lib/assistant";
import { getRecentMessages } from "@/lib/db";

export async function GET() {
  return Response.json(getRecentMessages());
}

export async function POST(request: Request) {
  const { message } = (await request.json()) as { message: string };

  if (!message || typeof message !== "string") {
    return new Response("Missing 'message' string in request body", { status: 400 });
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of streamAssistantReply(message, "text")) {
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            `\n\n[PATTSON encountered an error, sir: ${err instanceof Error ? err.message : String(err)}]`
          )
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
