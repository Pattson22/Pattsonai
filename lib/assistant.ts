import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, OutputMode } from "./persona";
import { getRecentMessages, insertMessage, logActivity } from "./db";
import { findTool, toolDefinitionsForClaude } from "./tools";

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;
// Safety cap on the tool-use loop below -- not a permission gate (PATTSON's
// persona explicitly forgoes those), just an engineering guard against a
// runaway back-and-forth if the model keeps requesting tools indefinitely.
const MAX_TOOL_ITERATIONS = 8;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function historyForClaude(): Anthropic.MessageParam[] {
  return getRecentMessages().map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

/** Execute one tool call, logging the attempt to activity_log either way.
 * Never throws -- a failing tool becomes an is_error tool_result so Claude
 * can explain the hurdle in character (see lib/persona.ts's error-handling
 * instruction) instead of the whole request blowing up. */
async function executeTool(
  name: string,
  input: Record<string, unknown>
): Promise<{ output: unknown; isError: boolean }> {
  const tool = findTool(name);
  if (!tool) {
    const output = { error: `Unknown tool: ${name}` };
    logActivity(name, input, "error", output);
    return { output, isError: true };
  }

  try {
    const output = await tool.handler(input);
    logActivity(name, input, "success", output);
    return { output, isError: false };
  } catch (err) {
    const output = { error: err instanceof Error ? err.message : String(err) };
    logActivity(name, input, "error", output);
    return { output, isError: true };
  }
}

/**
 * Send `userMessage`, stream PATTSON's reply back as an async generator of
 * text chunks, executing any tool calls Claude makes along the way, and
 * persist both sides of the exchange to SQLite once the reply is final.
 *
 * This is the standard agentic tool-use loop: stream text as it arrives,
 * and whenever Claude's turn ends with one or more tool_use blocks, run
 * them, feed the results back as a new user turn, and continue -- until a
 * turn ends with no further tool calls, or MAX_TOOL_ITERATIONS is hit.
 */
export async function* streamAssistantReply(
  userMessage: string,
  mode: OutputMode = "text"
): AsyncGenerator<string> {
  insertMessage("user", userMessage);

  let messages = historyForClaude();
  let fullReplyForStorage = "";

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(mode),
      messages,
      tools: toolDefinitionsForClaude(),
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        fullReplyForStorage += event.delta.text;
        yield event.delta.text;
      }
    }

    const finalMessage = await stream.finalMessage();
    messages = [...messages, { role: "assistant", content: finalMessage.content }];

    const toolUseBlocks = finalMessage.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const { output, isError } = await executeTool(block.name, block.input as Record<string, unknown>);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(output),
        is_error: isError,
      });
    }
    messages = [...messages, { role: "user", content: toolResults }];
  }

  insertMessage("assistant", fullReplyForStorage);
}
