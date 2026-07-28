import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local"
  );
}

/**
 * Cliente con privilegios de servicio (bypass RLS). Uso exclusivo en
 * codigo server-side sin sesion de usuario (webhook de WhatsApp, jobs).
 * Nunca importar desde codigo que se ejecute en el navegador.
 */
export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
