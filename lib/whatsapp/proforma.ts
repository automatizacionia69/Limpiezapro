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

export type ResultadoGenerarProforma =
  | { ok: true; proforma: ResultadoProforma }
  /** Alguna linea no tiene precio valido: no se crea nada en el ERP. */
  | { ok: false; motivo: "sin_precio" }
  | { ok: false; motivo: "sin_items" }
  | { ok: false; motivo: "error" };

/**
 * Busca el cliente por telefono y lo crea si no existe, en un solo paso
 * atomico del lado de la base (RPC obtener_o_crear_cliente_por_telefono,
 * ver add-dedupe-clientes-telefono.sql en el repo del ERP).
 *
 * Antes esto traia hasta 5000 clientes y comparaba telefonos normalizados en
 * memoria: funcionaba, pero dos mensajes casi simultaneos del mismo cliente
 * (dos instancias serverless de Vercel, que no comparten memoria) podian no
 * verse entre si y crear un cliente Y una cotizacion duplicados. La columna
 * `clientes.telefono_normalizado` ahora tiene un INDICE UNICO, y la funcion
 * hace INSERT ... ON CONFLICT ... RETURNING en una sola sentencia: la base
 * misma impide el duplicado, sin ventana de carrera. Tampoco pisa el nombre
 * de un cliente que ya existia (si un admin lo corrigio a mano en el ERP, no
 * se sobreescribe con el nombre de perfil de WhatsApp del siguiente mensaje).
 */
async function obtenerOCrearCliente(
  telefono: string,
  nombrePerfil: string | null
): Promise<number | null> {
  const nombre = nombrePerfil?.trim() || `Cliente WhatsApp ${telefono}`;

  const { data, error } = await supabaseAdmin.rpc(
    "obtener_o_crear_cliente_por_telefono",
    { p_telefono: telefono, p_nombre: nombre }
  );

  if (error || typeof data !== "number") {
    console.error("Error obteniendo/creando cliente:", error);
    return null;
  }

  return data;
}

/**
 * Crea una cotizacion real en las tablas del ERP (cotizaciones +
 * detalle_cotizacion) a partir del carrito armado por WhatsApp. El numero
 * (COT-00001...) lo genera la base de datos.
 *
 * Nota: son dos inserts secuenciales via REST, sin transaccion. Si el
 * segundo falla, se compensa borrando la cabecera recien creada (para no
 * dejar una cotizacion fantasma con importes pero sin items) — si ademas
 * ese borrado fallara, recien ahi se loggea para revision manual. Mismo
 * patron que usa el resto del proyecto — no hay RPC/transaccion multi-tabla
 * todavia.
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

    // Se compensa el insert de la cabecera para no dejar una cotizacion
    // fantasma (con importes pero sin ninguna linea) visible en el ERP.
    const { error: errorBorrado } = await supabaseAdmin
      .from("cotizaciones")
      .delete()
      .eq("id", cotizacion.id);

    if (errorBorrado) {
      console.error(
        `No se pudo revertir la cotizacion huerfana ${cotizacion.numero} ` +
          `(id ${cotizacion.id}) tras fallar su detalle — requiere revision manual:`,
        errorBorrado
      );
    }

    return { ok: false, motivo: "error" };
  }

  return { ok: true, proforma: { numero: cotizacion.numero, subtotal, igv, total } };
}
