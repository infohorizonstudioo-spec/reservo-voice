import Anthropic from "@anthropic-ai/sdk";
import { CallContext } from "./context";
import { buildSystemPrompt } from "./prompts";
import { TOOL_DEFINITIONS, executeTool } from "./tools";

const anthropic = new Anthropic();

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 200; // Voice — keep responses short

export interface LlmResult {
  text: string;
  endCall: boolean;
}

// ── Conversación por llamada ────────────────────────────────────────
const conversations = new Map<string, Anthropic.MessageParam[]>();

export function getHistory(callId: string): Anthropic.MessageParam[] {
  if (!conversations.has(callId)) {
    conversations.set(callId, []);
  }
  return conversations.get(callId)!;
}

export function clearHistory(callId: string): void {
  conversations.delete(callId);
}

// ── Procesa un turno de usuario ─────────────────────────────────────
export async function processUserTurn(
  userText: string,
  ctx: CallContext,
): Promise<LlmResult> {
  const history = getHistory(ctx.callId);
  history.push({ role: "user", content: userText });

  const systemPrompt = buildSystemPrompt(ctx);
  let endCall = false;

  // Loop de tool use (max 3 iteraciones)
  for (let i = 0; i < 3; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools: TOOL_DEFINITIONS,
      messages: history,
    });

    // Acumular respuesta del asistente
    history.push({ role: "assistant", content: response.content });

    // Si stop_reason es end_turn o no hay tool_use, devolver texto
    if (response.stop_reason === "end_turn" || !hasToolUse(response.content)) {
      const text = extractText(response.content);
      return { text, endCall };
    }

    // Ejecutar tools
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const result = await executeTool(
          block.name,
          block.input as Record<string, unknown>,
          ctx,
        );
        if (result.endCall) endCall = true;
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.result,
        });
      }
    }

    // Agregar resultados de tools como mensaje de usuario (patrón Anthropic)
    history.push({ role: "user", content: toolResults });
  }

  // Si después de 3 iteraciones no termina, devolver último texto
  return { text: "¿Puedo ayudarle en algo más?", endCall };
}

// ── Helpers ──────────────────────────────────────────────────────────
function hasToolUse(content: Anthropic.ContentBlock[]): boolean {
  return content.some((b) => b.type === "tool_use");
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
}
