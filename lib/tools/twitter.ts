import { TwitterApi } from "twitter-api-v2";
import { ToolDefinition } from "./index";
import { countRecentActivity } from "../db";

// Engineering safety net against a runaway loop or repeated tool-call bug --
// NOT a permission gate. PATTSON's persona explicitly forgoes confirmation
// before posting; this only stops something pathological, not a deliberate
// burst of legitimate posts.
const MAX_POSTS_PER_HOUR = 5;

function getClient(): TwitterApi {
  const { TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET } = process.env;
  if (!TWITTER_API_KEY || !TWITTER_API_SECRET || !TWITTER_ACCESS_TOKEN || !TWITTER_ACCESS_TOKEN_SECRET) {
    throw new Error(
      "X/Twitter credentials are not configured -- set TWITTER_API_KEY, TWITTER_API_SECRET, " +
        "TWITTER_ACCESS_TOKEN, and TWITTER_ACCESS_TOKEN_SECRET in .env.local (see .env.local.example)."
    );
  }
  return new TwitterApi({
    appKey: TWITTER_API_KEY,
    appSecret: TWITTER_API_SECRET,
    accessToken: TWITTER_ACCESS_TOKEN,
    accessSecret: TWITTER_ACCESS_TOKEN_SECRET,
  });
}

const postTweet: ToolDefinition = {
  name: "post_tweet",
  description:
    "Post a tweet to X (Twitter) immediately, on the user's behalf. This publishes directly with " +
    "no confirmation step -- only call this when the user has clearly asked to post something to " +
    "X/Twitter, and craft the exact final text yourself (max 280 characters).",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The exact tweet text to post, max 280 characters." },
    },
    required: ["text"],
  },
  handler: async (input) => {
    const text = input.text;
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("Missing required 'text' field");
    }
    if (text.length > 280) {
      throw new Error(`Tweet text is ${text.length} characters, over the 280-character limit`);
    }

    const recentCount = countRecentActivity("post_tweet", 60);
    if (recentCount >= MAX_POSTS_PER_HOUR) {
      throw new Error(
        `Rate guard: already posted ${recentCount} tweet(s) in the last hour (max ${MAX_POSTS_PER_HOUR}). ` +
          "This is a runaway-loop safety net, not a permission gate."
      );
    }

    const client = getClient();
    const { data } = await client.v2.tweet(text);
    return { id: data.id, text: data.text, url: `https://x.com/i/web/status/${data.id}` };
  },
};

export const twitterTools: ToolDefinition[] = [postTweet];
