import { ToolDefinition } from "./index";
import { countRecentActivity } from "../db";

// Engineering safety net, not a permission gate -- see twitter.ts.
const MAX_POSTS_PER_HOUR = 5;
// Bump this if Meta deprecates the version -- Graph API versions are
// retired roughly every 2 years.
const GRAPH_API_VERSION = "v21.0";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Instagram credentials are not configured -- set ${name} in .env.local (see .env.local.example ` +
        "and the README's Instagram setup section for the required Meta app review)."
    );
  }
  return value;
}

async function graphApiPost(path: string, params: Record<string, string>): Promise<Record<string, string>> {
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), { method: "POST" });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Instagram Graph API error: ${body?.error?.message ?? response.statusText}`);
  }
  return body;
}

const postInstagram: ToolDefinition = {
  name: "post_instagram",
  description:
    "Post an image to Instagram immediately, on the user's behalf. This publishes directly with " +
    "no confirmation step. Instagram has no text-only post type -- an image is required. " +
    "`image_url` must already be a publicly reachable URL (Instagram's servers fetch it directly); " +
    "PATTSON cannot generate or host images itself in this version, so only call this tool when " +
    "the user has provided or referenced an actual image URL. This also requires the user's Meta " +
    "app to have completed App Review for content publishing -- if it hasn't, this call will fail " +
    "with a permissions error, which is expected until that external review completes.",
  input_schema: {
    type: "object",
    properties: {
      image_url: { type: "string", description: "Publicly reachable URL of the image to post." },
      caption: { type: "string", description: "Optional caption text for the post." },
    },
    required: ["image_url"],
  },
  handler: async (input) => {
    const imageUrl = input.image_url;
    if (typeof imageUrl !== "string" || imageUrl.length === 0) {
      throw new Error("Missing required 'image_url' field");
    }
    const caption = typeof input.caption === "string" ? input.caption : undefined;

    const recentCount = countRecentActivity("post_instagram", 60);
    if (recentCount >= MAX_POSTS_PER_HOUR) {
      throw new Error(
        `Rate guard: already posted ${recentCount} time(s) to Instagram in the last hour ` +
          `(max ${MAX_POSTS_PER_HOUR}). This is a runaway-loop safety net, not a permission gate.`
      );
    }

    const accessToken = requireEnv("INSTAGRAM_ACCESS_TOKEN");
    const businessAccountId = requireEnv("INSTAGRAM_BUSINESS_ACCOUNT_ID");

    // Two-step Graph API flow: create a media container, then publish it.
    const container = await graphApiPost(`${businessAccountId}/media`, {
      image_url: imageUrl,
      ...(caption ? { caption } : {}),
      access_token: accessToken,
    });

    const published = await graphApiPost(`${businessAccountId}/media_publish`, {
      creation_id: container.id,
      access_token: accessToken,
    });

    return { media_id: published.id, image_url: imageUrl, caption: caption ?? null };
  },
};

export const instagramTools: ToolDefinition[] = [postInstagram];
