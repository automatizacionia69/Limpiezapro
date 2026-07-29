import { supabaseAdmin } from "@/lib/supabase/admin";
import type { ItemCarrito } from "./carrito";

/** Misma tasa que usa el ERP (src/lib/cotizaciones.ts: IGV_TASA). */
const IGV_TASA = 0.18;

export interface ResultadoProforma {
  numero: string;
  subtotal: number;
  igv: number;
  total: number;
}

async function obtenerOCrearCliente(
  telefono: string,
  nombrePerfil: string | null
): Promise<number | null> {
  const { data: existente, error: errorBusqueda } = await supabaseAdmin
    .from("clientes")
    .select("id")
    .eq("telefono", telefono)
    .limit(1)
    .maybeSingle();

  if (errorBusqueda) {
    console.error("Error buscando cliente por telefono:", errorBusqueda);
    return null;
  }
  if (existente) return existente.id;

  const nombre = nombrePerfil?.trim() || `Cliente WhatsApp ${telefono}`;

  const { data: creado, error: errorCrear } = await supabaseAdmin
    .from("clientes")
    .insert({ nombre, telefono })
    .select("id")
    .single();

  if (errorCrear || !creado) {
    console.error("Error creando cliente:", errorCrear);
    return null;
  }

  return creado.id;
}

/**
 * Crea una cotizacion real en las tablas del ERP (cotizaciones +
 * detalle_cotizacion) a partir del carrito armado por WhatsApp. El numero
 * (COT-00001...) lo genera la base de datos.
 *
 * Nota: son dos inserts secuenciales via REST, sin transaccion. Si el
 * segundo falla, la cabecera de la cotizacion queda creada pero sin items
 * (se loggea el error para revision manual). Mismo patron que usa el resto
 * del proyecto — no hay RPC/transaccion multi-tabla todavia.
 */
export async function generarProforma(
  telefono: string,
  nombrePerfil: string | null,
  items: ItemCarrito[]
): Promise<ResultadoProforma | null> {
  if (items.length === 0) return null;

  const clienteId = await obtenerOCrearCliente(telefono, nombrePerfil);
  if (clienteId === null) return null;

  const subtotal = items.reduce((acc, i) => acc + i.cantidad * i.precioUnitario, 0);
  const igv = subtotal * IGV_TASA;
  const total = subtotal + igv;

  const { data: cotizacion, error: errorCotizacion } = await supabaseAdmin
    .from("cotizaciones")
    .insert({
      cliente_id: clienteId,
      subtotal,
      igv,
      total,
      observacion: "Generada automáticamente desde el chatbot de WhatsApp.",
    })
    .select("id, numero")
    .single();

  if (errorCotizacion || !cotizacion) {
    console.error("Error creando cotizacion:", errorCotizacion);
    return null;
  }

  const detalle = items.map((item) => ({
    cotizacion_id: cotizacion.id,
    producto_id: item.productoId,
    cantidad: item.cantidad,
    precio_unitario: item.precioUnitario,
  }));

  const { error: errorDetalle } = await supabaseAdmin
    .from("detalle_cotizacion")
    .insert(detalle);

  if (errorDetalle) {
    console.error(
      `Error creando detalle_cotizacion para cotizacion ${cotizacion.numero}:`,
      errorDetalle
    );
    return null;
  }

  return { numero: cotizacion.numero, subtotal, igv, total };
}
