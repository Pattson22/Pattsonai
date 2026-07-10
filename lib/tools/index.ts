import Anthropic from "@anthropic-ai/sdk";
import { twitterTools } from "./twitter";
import { instagramTools } from "./instagram";
import { tiktokTools } from "./tiktok";
import { memoryTools } from "./memory";

/**
 * One module per real automation (see twitter.ts, instagram.ts, tiktok.ts)
 * -- adding a new automation later means adding one file + one line here,
 * not restructuring anything.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

const getCurrentTime: ToolDefinition = {
  name: "get_current_time",
  description:
    "Get the current date and time in UTC. Use this whenever you need to know 'now' -- for scheduling, timestamps, or answering time-related questions.",
  input_schema: { type: "object", properties: {}, required: [] },
  handler: async () => ({ utc: new Date().toISOString() }),
};

export const toolRegistry: ToolDefinition[] = [
  getCurrentTime,
  ...memoryTools,
  ...twitterTools,
  ...instagramTools,
  ...tiktokTools,
];

export function toolDefinitionsForClaude(): Anthropic.Tool[] {
  return toolRegistry.map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }));
}

export function findTool(name: string): ToolDefinition | undefined {
  return toolRegistry.find((t) => t.name === name);
}
