import "dotenv/config";
import { WebSocketServer, WebSocket } from "ws";
import { loadCallContext, CallContext } from "./context";
import { processUserTurn, clearHistory } from "./llm";

const PORT = Number(process.env.PORT) || 8081;

// ── Tipos de mensajes Retell ────────────────────────────────────────
interface RetellRequest {
  interaction_type: "call_details" | "update_only" | "response_required" | "reminder_required";
  call: {
    call_id: string;
    from_number: string;
    to_number: string;
    retell_llm_dynamic_variables?: Record<string, string>;
    metadata?: Record<string, string>;
  };
  transcript?: Array<{
    role: "agent" | "user";
    content: string;
  }>;
}

interface RetellResponse {
  response_id: number;
  content: string;
  content_complete: boolean;
  end_call?: boolean;
}

// ── Estado por conexión ─────────────────────────────────────────────
interface ConnectionState {
  ctx: CallContext | null;
  responseId: number;
}

// ── WebSocket Server ────────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });

console.log(`[reservo-voice] WebSocket server listening on port ${PORT}`);

wss.on("connection", (ws: WebSocket) => {
  const state: ConnectionState = { ctx: null, responseId: 0 };

  ws.on("message", async (data: Buffer) => {
    let msg: RetellRequest;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    try {
      await handleMessage(ws, msg, state);
    } catch (err) {
      console.error("[reservo-voice] Error handling message:", err);
      sendResponse(ws, state, "Lo siento, ha ocurrido un error. Por favor, llame de nuevo.", true);
    }
  });

  ws.on("close", () => {
    if (state.ctx) {
      clearHistory(state.ctx.callId);
    }
  });

  ws.on("error", (err) => {
    console.error("[reservo-voice] WebSocket error:", err);
  });
});

// ── Handler principal ───────────────────────────────────────────────
async function handleMessage(
  ws: WebSocket,
  msg: RetellRequest,
  state: ConnectionState,
): Promise<void> {
  switch (msg.interaction_type) {
    case "call_details": {
      // Primera interacción — cargar contexto del tenant
      const agentId = msg.call.metadata?.retell_agent_id
        ?? msg.call.retell_llm_dynamic_variables?.retell_agent_id
        ?? "";

      state.ctx = await loadCallContext(
        agentId,
        msg.call.from_number,
        msg.call.call_id,
      );

      // Saludo inicial
      const greeting = await processUserTurn(
        "[El cliente acaba de llamar. Salúdale brevemente.]",
        state.ctx,
      );
      sendResponse(ws, state, greeting.text, greeting.endCall);
      break;
    }

    case "response_required":
    case "reminder_required": {
      if (!state.ctx) {
        sendResponse(ws, state, "Un momento, por favor.", false);
        return;
      }

      // Extraer último mensaje del usuario del transcript
      const userText = getLastUserMessage(msg.transcript);
      if (!userText) {
        // reminder sin texto nuevo — gentle nudge
        sendResponse(ws, state, "¿Sigue ahí? ¿En qué puedo ayudarle?", false);
        return;
      }

      const result = await processUserTurn(userText, state.ctx);
      sendResponse(ws, state, result.text, result.endCall);
      break;
    }

    case "update_only":
      // No response needed
      break;
  }
}

// ── Enviar respuesta a Retell ───────────────────────────────────────
function sendResponse(
  ws: WebSocket,
  state: ConnectionState,
  content: string,
  endCall: boolean,
): void {
  if (ws.readyState !== WebSocket.OPEN) return;

  const response: RetellResponse = {
    response_id: state.responseId++,
    content,
    content_complete: true,
    end_call: endCall || undefined,
  };

  ws.send(JSON.stringify(response));
}

// ── Extraer último mensaje del usuario ──────────────────────────────
function getLastUserMessage(
  transcript?: Array<{ role: string; content: string }>,
): string | null {
  if (!transcript || transcript.length === 0) return null;

  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === "user" && transcript[i].content.trim()) {
      return transcript[i].content.trim();
    }
  }
  return null;
}
