import { ToolDefinition } from "./index";
import { countRecentActivity } from "../db";

// Engineering safety net, not a permission gate -- see twitter.ts.
const MAX_POSTS_PER_HOUR = 5;
const TIKTOK_API_BASE = "https://open.tiktokapis.com/v2";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `TikTok credentials are not configured -- set ${name} in .env.local (see .env.local.example ` +
        "and the README's TikTok setup section for the required developer app review)."
    );
  }
  return value;
}

const postTiktok: ToolDefinition = {
  name: "post_tiktok",
  description:
    "Post a video to TikTok immediately, on the user's behalf, via TikTok's Direct Post API. This " +
    "publishes directly with no confirmation step. `video_url` must already be a publicly reachable " +
    "URL (TikTok's servers pull the video directly); PATTSON cannot generate or host video itself in " +
    "this version. IMPORTANT: until the user's TikTok developer app has completed review, posts can " +
    "only use privacy_level 'SELF_ONLY' (private, visible only to the poster) -- default to that " +
    "unless the user has explicitly said their app is approved for public posting, otherwise the " +
    "call will fail.",
  input_schema: {
    type: "object",
    properties: {
      video_url: { type: "string", description: "Publicly reachable URL of the video to post." },
      title: { type: "string", description: "Caption/title for the post." },
      privacy_level: {
        type: "string",
        enum: ["SELF_ONLY", "PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR"],
        description: "Who can see the post. Defaults to SELF_ONLY, required for unaudited apps.",
      },
    },
    required: ["video_url"],
  },
  handler: async (input) => {
    const videoUrl = input.video_url;
    if (typeof videoUrl !== "string" || videoUrl.length === 0) {
      throw new Error("Missing required 'video_url' field");
    }
    const title = typeof input.title === "string" ? input.title : "";
    const privacyLevel = typeof input.privacy_level === "string" ? input.privacy_level : "SELF_ONLY";

    const recentCount = countRecentActivity("post_tiktok", 60);
    if (recentCount >= MAX_POSTS_PER_HOUR) {
      throw new Error(
        `Rate guard: already posted ${recentCount} time(s) to TikTok in the last hour ` +
          `(max ${MAX_POSTS_PER_HOUR}). This is a runaway-loop safety net, not a permission gate.`
      );
    }

    const accessToken = requireEnv("TIKTOK_ACCESS_TOKEN");

    const response = await fetch(`${TIKTOK_API_BASE}/post/publish/video/init/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        post_info: { title, privacy_level: privacyLevel },
        source_info: { source: "PULL_FROM_URL", video_url: videoUrl },
      }),
    });

    const body = await response.json();
    if (!response.ok || body?.error?.code !== "ok") {
      throw new Error(`TikTok API error: ${body?.error?.message ?? response.statusText}`);
    }

    return { publish_id: body.data.publish_id, privacy_level: privacyLevel, status: "processing" };
  },
};

export const tiktokTools: ToolDefinition[] = [postTiktok];
