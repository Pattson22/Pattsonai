import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, OutputMode } from "./persona";
import { getRecentMessages, getAllMemories, insertMessage, deleteMessage, logActivity } from "./db";
import { findTool, toolDefinitionsForClaude } from "./tools";

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;
// Safety cap on the tool-use loop below -- not a permission gate (Pat's
// persona explicitly forgoes those), just an engineering guard against a
// runaway back-and-forth if the model keeps requesting tools indefinitely.
const MAX_TOOL_ITERATIONS = 8;

// Anthropic-hosted server tool -- runs entirely on Anthropic's side (no
// local handler, unlike the tools in lib/tools/index.ts). This is what
// gives Pat real-time information Claude's training data can't have
// (weather, news, current prices, "what happened today"), same mechanism
// claude.ai itself uses for that. max_uses caps searches per reply so a
// confused turn can't spiral into an expensive research spree.
//
// Deliberately the "basic" tool version (not the newer dynamic-filtering
// _20260209 variant): the dynamic-filtering version runs its filtering as
// code execution under the hood and expects a `container` id to be threaded
// through follow-up requests when a search spans multiple turns, which this
// app's simple history-replay loop (lib/db.ts) doesn't track -- it 400s
// with "container_id is required" the moment a search needs to continue.
// The basic variant is a plain single-shot search with no such state.
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 3 } as const;

// Also Anthropic-hosted, same no-local-handler pattern as web search. Closes
// a real gap: persona.ts's own response-style examples already describe Pat
// "running a math tool" for things like compound interest -- until now
// nothing backed that up. Billed free when used alongside web search, which
// is already in the tools list below.
const CODE_EXECUTION_TOOL = { type: "code_execution_20260521", name: "code_execution" } as const;

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
 * Send `userMessage`, stream Pat's reply back as an async generator of
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
  mode: OutputMode = "text",
  signal?: AbortSignal
): AsyncGenerator<string> {
  const userMessageId = insertMessage("user", userMessage);

  let messages = historyForClaude();
  let fullReplyForStorage = "";
  const memories = getAllMemories().map((m) => m.content);
  const systemPrompt = buildSystemPrompt(mode, memories);

  // Sonnet 5 runs adaptive extended thinking + "high" effort by default
  // unless told otherwise -- great for hard reasoning, but adds a real
  // reasoning phase before any text streams back. Voice is spoken back
  // aloud, so speed to first token matters far more there than reasoning
  // depth; text mode has no TTS wait, so it can afford real thinking.
  const isVoice = mode === "voice";

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const stream = anthropic.messages.stream(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages,
          tools: [...toolDefinitionsForClaude(), WEB_SEARCH_TOOL, CODE_EXECUTION_TOOL],
          thinking: isVoice ? { type: "disabled" } : { type: "adaptive" },
          output_config: { effort: isVoice ? "low" : "medium" },
        },
        { signal }
      );

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
  } catch (err) {
    if (signal?.aborted) {
      // The user interrupted this reply with a follow-up -- discard the
      // abandoned turn entirely (no reply was ever produced for it) rather
      // than leaving an orphaned, unanswered message sitting in history.
      deleteMessage(userMessageId);
      return;
    }
    throw err;
  }
}
