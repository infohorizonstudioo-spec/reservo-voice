import Anthropic from "@anthropic-ai/sdk";
import { CallContext, getLabels } from "./context";

// ── Definiciones de tools para Claude ────────────────────────────────
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "check_availability",
    description:
      "Consulta la disponibilidad de horarios para una fecha y número de personas. " +
      "Devuelve los slots disponibles.",
    input_schema: {
      type: "object" as const,
      properties: {
        date: {
          type: "string",
          description: "Fecha en formato YYYY-MM-DD",
        },
        time: {
          type: "string",
          description: "Hora preferida en formato HH:MM (24h)",
        },
        party_size: {
          type: "number",
          description: "Número de personas / comensales / pacientes",
        },
      },
      required: ["date", "time", "party_size"],
    },
  },
  {
    name: "create_reservation",
    description:
      "Crea una reserva/cita/sesión confirmada con los datos del cliente.",
    input_schema: {
      type: "object" as const,
      properties: {
        customer_name: {
          type: "string",
          description: "Nombre del cliente/paciente",
        },
        customer_phone: {
          type: "string",
          description: "Teléfono del cliente (puede ser el del llamante)",
        },
        date: {
          type: "string",
          description: "Fecha en formato YYYY-MM-DD",
        },
        time: {
          type: "string",
          description: "Hora en formato HH:MM (24h)",
        },
        party_size: {
          type: "number",
          description: "Número de personas",
        },
        notes: {
          type: "string",
          description: "Notas adicionales (alergias, motivo consulta, etc.)",
        },
      },
      required: ["customer_name", "date", "time", "party_size"],
    },
  },
  {
    name: "end_call",
    description:
      "Finaliza la llamada. Usar cuando la conversación ha terminado.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "Motivo de finalización: completed | no_availability | customer_request | error",
        },
      },
      required: ["reason"],
    },
  },
];

// ── Tipos de input ──────────────────────────────────────────────────
interface CheckAvailabilityInput {
  date: string;
  time: string;
  party_size: number;
}

interface CreateReservationInput {
  customer_name: string;
  customer_phone?: string;
  date: string;
  time: string;
  party_size: number;
  notes?: string;
}

interface EndCallInput {
  reason: string;
}

// ── Ejecutor de tools ───────────────────────────────────────────────
export async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: CallContext,
): Promise<{ result: string; endCall?: boolean }> {
  switch (toolName) {
    case "check_availability":
      return checkAvailability(toolInput as unknown as CheckAvailabilityInput, ctx);
    case "create_reservation":
      return createReservation(toolInput as unknown as CreateReservationInput, ctx);
    case "end_call":
      return endCall(toolInput as unknown as EndCallInput, ctx);
    default:
      return { result: `Herramienta desconocida: ${toolName}` };
  }
}

// ── check_availability ──────────────────────────────────────────────
async function checkAvailability(
  input: CheckAvailabilityInput,
  ctx: CallContext,
): Promise<{ result: string }> {
  const L = getLabels(ctx.tenant.type);

  // Buscar reservas existentes en esa fecha/hora
  const { data: existing, error } = await ctx.supabase
    .from("reservations")
    .select("time, party_size, status")
    .eq("tenant_id", ctx.tenant.id)
    .eq("date", input.date)
    .in("status", ["confirmed", "pending_review"]);

  if (error) {
    return { result: `Error consultando disponibilidad: ${error.message}` };
  }

  // Lógica simple: contar ocupación en la franja ±1h
  const requestedMinutes = parseTime(input.time);
  const conflicting = (existing ?? []).filter((r) => {
    const rMinutes = parseTime(r.time);
    return Math.abs(rMinutes - requestedMinutes) < 90; // solapamiento 90min
  });

  const totalOccupied = conflicting.reduce(
    (sum, r) => sum + (r.party_size ?? 1),
    0,
  );

  // Capacidad simple — se puede refinar con tabla de recursos
  const maxCapacity = (ctx.tenant.config as Record<string, number>).max_capacity ?? 20;

  if (totalOccupied + input.party_size <= maxCapacity) {
    return {
      result: `Hay disponibilidad para ${input.party_size} persona(s) el ${input.date} a las ${input.time}. Puede proceder a crear la ${L.res}.`,
    };
  }

  // Buscar alternativas
  const alternatives = findAlternativeSlots(existing ?? [], requestedMinutes, maxCapacity, input.party_size);
  if (alternatives.length > 0) {
    const altText = alternatives.map((t) => formatTime(t)).join(", ");
    return {
      result: `No hay disponibilidad a las ${input.time}. Horarios alternativos disponibles: ${altText}.`,
    };
  }

  return {
    result: `Lo siento, no hay disponibilidad el ${input.date} para ${input.party_size} persona(s). Sugiera otra fecha.`,
  };
}

// ── create_reservation ──────────────────────────────────────────────
async function createReservation(
  input: CreateReservationInput,
  ctx: CallContext,
): Promise<{ result: string }> {
  const L = getLabels(ctx.tenant.type);

  // Upsert customer
  const phone = input.customer_phone ?? ctx.callerPhone;
  const { data: customer } = await ctx.supabase
    .from("customers")
    .upsert(
      {
        tenant_id: ctx.tenant.id,
        name: input.customer_name,
        phone,
      },
      { onConflict: "tenant_id,phone" },
    )
    .select("id")
    .single();

  // Crear reserva
  const { data: reservation, error } = await ctx.supabase
    .from("reservations")
    .insert({
      tenant_id: ctx.tenant.id,
      customer_id: customer?.id ?? null,
      customer_name: input.customer_name,
      customer_phone: phone,
      date: input.date,
      time: input.time,
      party_size: input.party_size,
      notes: input.notes ?? null,
      status: "confirmed",
      source: "voice",
      call_id: ctx.callId,
    })
    .select("id")
    .single();

  if (error) {
    return { result: `Error al crear la ${L.res}: ${error.message}` };
  }

  return {
    result: `${L.res.charAt(0).toUpperCase() + L.res.slice(1)} creada con éxito (ID: ${reservation!.id}). ` +
      `${input.customer_name}, ${input.date} a las ${input.time}, ${input.party_size} persona(s).`,
  };
}

// ── end_call ────────────────────────────────────────────────────────
async function endCall(
  input: EndCallInput,
  ctx: CallContext,
): Promise<{ result: string; endCall: boolean }> {
  // Registrar la llamada
  await ctx.supabase.from("calls").insert({
    tenant_id: ctx.tenant.id,
    call_id: ctx.callId,
    caller_phone: ctx.callerPhone,
    status: "completed",
    end_reason: input.reason,
    ended_at: new Date().toISOString(),
  });

  return { result: "Llamada finalizada.", endCall: true };
}

// ── Helpers ─────────────────────────────────────────────────────────
function parseTime(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m ?? 0);
}

function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function findAlternativeSlots(
  existing: { time: string; party_size: number }[],
  requestedMinutes: number,
  maxCapacity: number,
  partySize: number,
): number[] {
  const alternatives: number[] = [];
  // Check slots from -2h to +2h in 30min intervals
  for (let offset = -120; offset <= 120; offset += 30) {
    if (offset === 0) continue;
    const candidate = requestedMinutes + offset;
    if (candidate < 480 || candidate > 1380) continue; // 08:00 - 23:00

    const occupied = existing
      .filter((r) => Math.abs(parseTime(r.time) - candidate) < 90)
      .reduce((sum, r) => sum + (r.party_size ?? 1), 0);

    if (occupied + partySize <= maxCapacity) {
      alternatives.push(candidate);
      if (alternatives.length >= 3) break;
    }
  }
  return alternatives;
}
