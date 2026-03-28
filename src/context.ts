import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ── Types ───────────────────────────────────────────────────────────
export type BusinessType =
  | "restaurante" | "bar" | "cafeteria"
  | "clinica_dental" | "clinica_medica" | "veterinaria"
  | "peluqueria" | "barberia" | "fisioterapia"
  | "psicologia" | "asesoria" | "seguros"
  | "inmobiliaria" | "gimnasio" | "academia"
  | "spa" | "taller" | "hotel" | "ecommerce";

export interface Tenant {
  id: string;
  name: string;
  type: BusinessType;
  phone: string | null;
  timezone: string;
  config: Record<string, unknown>;
}

export interface CallContext {
  tenant: Tenant;
  callerPhone: string;
  callId: string;
  supabase: SupabaseClient;
}

// ── Labels por tipo de negocio ──────────────────────────────────────
const LABELS: Record<BusinessType, { res: string; unit: string; customer: string }> = {
  restaurante:    { res: "reserva",  unit: "mesa",       customer: "cliente"  },
  bar:            { res: "reserva",  unit: "mesa",       customer: "cliente"  },
  cafeteria:      { res: "reserva",  unit: "mesa",       customer: "cliente"  },
  clinica_dental: { res: "cita",     unit: "silla",      customer: "paciente" },
  clinica_medica: { res: "cita",     unit: "consulta",   customer: "paciente" },
  veterinaria:    { res: "cita",     unit: "consulta",   customer: "cliente"  },
  peluqueria:     { res: "cita",     unit: "sillón",     customer: "cliente"  },
  barberia:       { res: "cita",     unit: "sillón",     customer: "cliente"  },
  fisioterapia:   { res: "cita",     unit: "consulta",   customer: "paciente" },
  psicologia:     { res: "sesión",   unit: "consulta",   customer: "paciente" },
  asesoria:       { res: "cita",     unit: "despacho",   customer: "cliente"  },
  seguros:        { res: "cita",     unit: "despacho",   customer: "cliente"  },
  inmobiliaria:   { res: "visita",   unit: "propiedad",  customer: "cliente"  },
  gimnasio:       { res: "clase",    unit: "sala",       customer: "socio"    },
  academia:       { res: "clase",    unit: "aula",       customer: "alumno"   },
  spa:            { res: "cita",     unit: "cabina",     customer: "cliente"  },
  taller:         { res: "cita",     unit: "bahía",      customer: "cliente"  },
  hotel:          { res: "reserva",  unit: "habitación", customer: "huésped"  },
  ecommerce:      { res: "pedido",   unit: "artículo",   customer: "cliente"  },
};

export function getLabels(type: BusinessType) {
  return LABELS[type] ?? LABELS.restaurante;
}

// ── Supabase ────────────────────────────────────────────────────────
let _supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!,
    );
  }
  return _supabase;
}

// ── Carga contexto del tenant por retell_agent_id ───────────────────
export async function loadCallContext(
  retellAgentId: string,
  callerPhone: string,
  callId: string,
): Promise<CallContext> {
  const supabase = getSupabase();

  const { data: tenant, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("retell_agent_id", retellAgentId)
    .single();

  if (error || !tenant) {
    throw new Error(`Tenant not found for retell_agent_id=${retellAgentId}`);
  }

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      type: tenant.type as BusinessType,
      phone: tenant.phone,
      timezone: tenant.timezone ?? "Europe/Madrid",
      config: tenant.config ?? {},
    },
    callerPhone,
    callId,
    supabase,
  };
}
