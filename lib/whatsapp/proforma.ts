import { supabaseAdmin } from "@/lib/supabase/admin";
import type { ItemCarrito } from "./carrito";
import { mismoTelefono, normalizarTelefono } from "./telefono";

/** Misma tasa que usa el ERP (src/lib/cotizaciones.ts: IGV_TASA). */
const IGV_TASA = 0.18;

/**
 * Tope de clientes a traer para comparar telefonos en memoria. La cartera real
 * es de decenas/cientos de clientes, asi que entra sin problema.
 */
const MAX_CLIENTES = 5000;

export interface ResultadoProforma {
  numero: string;
  subtotal: number;
  igv: number;
  total: number;
}

export type ResultadoGenerarProforma =
  | { ok: true; proforma: ResultadoProforma }
  /** Alguna linea no tiene precio valido: no se crea nada en el ERP. */
  | { ok: false; motivo: "sin_precio" }
  | { ok: false; motivo: "sin_items" }
  | { ok: false; motivo: "error" };

interface FilaCliente {
  id: number;
  telefono: string | null;
}

/**
 * Busca el cliente por telefono y lo crea si no existe.
 *
 * El telefono llega de WhatsApp como "51987654321", pero en el ERP se escribe
 * a mano en texto libre ("987 654 321", "+51 987-654-321"): un `.eq()` exacto
 * NUNCA matchea y se creaba un cliente duplicado "Cliente WhatsApp 51..." por
 * cada cotizacion. Por eso se traen los candidatos y se comparan normalizados
 * en memoria.
 *
 * PENDIENTE del lado de la base de datos (no se puede resolver desde aca):
 * falta una columna normalizada de telefono (solo digitos, sin prefijo de pais)
 * con INDICE UNICO, para poder buscar con un `.eq()` indexado y que la base
 * misma impida el duplicado en vez de depender de este chequeo.
 */
async function obtenerOCrearCliente(
  telefono: string,
  nombrePerfil: string | null
): Promise<number | null> {
  const canonico = normalizarTelefono(telefono);

  const { data: clientes, error: errorBusqueda } = await supabaseAdmin
    .from("clientes")
    .select("id, telefono")
    .not("telefono", "is", null)
    .limit(MAX_CLIENTES);

  if (errorBusqueda) {
    console.error("Error buscando cliente por telefono:", errorBusqueda);
    return null;
  }

  if (canonico.length > 0) {
    const existente = ((clientes ?? []) as FilaCliente[]).find((cliente) =>
      mismoTelefono(cliente.telefono, telefono)
    );
    if (existente) return existente.id;
  }

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
): Promise<ResultadoGenerarProforma> {
  // Snapshot inmutable ANTES del primer await: el carrito vive en memoria y el
  // cliente puede seguir mandando mensajes mientras esto corre. Si el total se
  // calculara de una lista que despues cambia, la cotizacion quedaria con una
  // linea que no esta sumada en el total.
  const lineas: ItemCarrito[] = items.map((item) => ({ ...item }));

  if (lineas.length === 0) return { ok: false, motivo: "sin_items" };

  // Red de seguridad: ningun item puede llegar con precio 0 a una cotizacion
  // real. Los llamadores ya lo filtran, pero esto es lo ultimo antes del ERP
  // (existe COT-00006 en produccion con dos lineas de Lejia en S/ 0.00).
  const sinPrecio = lineas.filter((item) => !(item.precioUnitario > 0));
  if (sinPrecio.length > 0) {
    console.error(
      "Cotizacion abortada: items sin precio valido (producto_id): " +
        sinPrecio.map((item) => item.productoId).join(", ")
    );
    return { ok: false, motivo: "sin_precio" };
  }

  const clienteId = await obtenerOCrearCliente(telefono, nombrePerfil);
  if (clienteId === null) return { ok: false, motivo: "error" };

  const subtotal = lineas.reduce((acc, i) => acc + i.cantidad * i.precioUnitario, 0);
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
    return { ok: false, motivo: "error" };
  }

  const detalle = lineas.map((item) => ({
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
    return { ok: false, motivo: "error" };
  }

  return { ok: true, proforma: { numero: cotizacion.numero, subtotal, igv, total } };
}
