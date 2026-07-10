import { ToolDefinition } from "./index";
import { insertMemory, deleteMemoriesMatching } from "../db";

const rememberFact: ToolDefinition = {
  name: "remember_fact",
  description:
    "Save a durable fact, preference, or piece of context about the user so it's available in " +
    "every future conversation, not just this one -- their name, standing preferences, ongoing " +
    "projects, recurring instructions. Use this unprompted whenever the user shares something " +
    "worth knowing long-term, per the seamless-execution principle. Do not use it for one-off " +
    "details that only matter for the current turn.",
  input_schema: {
    type: "object",
    properties: {
      fact: { type: "string", description: "The fact to remember, written as a short, self-contained statement." },
    },
    required: ["fact"],
  },
  handler: async (input) => {
    const fact = input.fact;
    if (typeof fact !== "string" || fact.trim().length === 0) {
      throw new Error("Missing required 'fact' field");
    }
    insertMemory(fact.trim());
    return { saved: fact.trim() };
  },
};

const forgetFact: ToolDefinition = {
  name: "forget_fact",
  description:
    "Remove previously remembered fact(s) that are wrong or outdated. `topic` is matched as a " +
    "case-insensitive substring against everything remembered -- any memory containing it is " +
    "deleted. Use this when the user corrects something you remembered, or asks you to forget it.",
  input_schema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "Substring to match against remembered facts for deletion." },
    },
    required: ["topic"],
  },
  handler: async (input) => {
    const topic = input.topic;
    if (typeof topic !== "string" || topic.trim().length === 0) {
      throw new Error("Missing required 'topic' field");
    }
    const removed = deleteMemoriesMatching(topic.trim());
    return { removed_count: removed, topic: topic.trim() };
  },
};

export const memoryTools: ToolDefinition[] = [rememberFact, forgetFact];
