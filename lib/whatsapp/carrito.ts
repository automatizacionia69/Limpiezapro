import { CANTIDAD_MAXIMA } from "./intent";

/**
 * Carrito en memoria por numero de telefono, entre mensajes de WhatsApp.
 *
 * Misma limitacion que rateLimit.ts y dedupe.ts: vive en memoria del proceso.
 * En Vercel, si el cliente tarda mucho entre selecciones y cae en otra
 * instancia serverless, el carrito puede aparecer vacio. Aceptable para el
 * MVP; para produccion real conviene mover esto a una tabla en Supabase.
 */

export interface ItemCarrito {
  productoId: number;
  nombre: string;
  cantidad: number;
  precioUnitario: number;
}

export type ResultadoAgregarItem =
  | { ok: true; item: ItemCarrito }
  /** El producto no tiene precio_venta cargado: cotizarlo daria S/ 0.00. */
  | { ok: false; motivo: "sin_precio" }
  /** La cantidad ACUMULADA de ese producto pasaria el tope. */
  | { ok: false; motivo: "tope_cantidad"; acumulado: number; maximo: number };

const VENTANA_MS = 30 * 60_000;

/** Cuanto dura el candado de "estoy generando la proforma" de un telefono. */
const VENTANA_GENERANDO_MS = 60_000;

const carritos = new Map<string, { items: ItemCarrito[]; expiraEn: number }>();

/** Telefonos con una proforma en curso -> hasta cuando vale el candado. */
const generandoProforma = new Map<string, number>();

function limpiarExpirados() {
  const ahora = Date.now();
  for (const [telefono, registro] of carritos) {
    if (ahora > registro.expiraEn) carritos.delete(telefono);
  }
}

export function agregarItem(
  telefono: string,
  producto: { id: number; nombre: string; precio_venta: number | null },
  cantidad = 1
): ResultadoAgregarItem {
  limpiarExpirados();

  // Sin precio cargado no se agrega: si entrara, la cotizacion del ERP
  // saldria con esa linea en S/ 0.00 (paso de verdad con COT-00006).
  if (producto.precio_venta === null || !(producto.precio_venta > 0)) {
    return { ok: false, motivo: "sin_precio" };
  }

  const ahora = Date.now();
  let registro = carritos.get(telefono);
  if (!registro || ahora > registro.expiraEn) {
    registro = { items: [], expiraEn: ahora + VENTANA_MS };
    carritos.set(telefono, registro);
  }
  registro.expiraEn = ahora + VENTANA_MS;

  const existente = registro.items.find((i) => i.productoId === producto.id);
  const yaTenia = existente?.cantidad ?? 0;
  const acumulado = yaTenia + cantidad;

  // El tope se valida sobre el ACUMULADO, no sobre el incremento: sin esto,
  // sumar 10 000 varias veces al mismo producto pasaba cada validacion
  // individual y terminaba en una cotizacion absurda.
  if (acumulado > CANTIDAD_MAXIMA) {
    return {
      ok: false,
      motivo: "tope_cantidad",
      acumulado: yaTenia,
      maximo: CANTIDAD_MAXIMA,
    };
  }

  if (existente) {
    existente.cantidad = acumulado;
    return { ok: true, item: { ...existente } };
  }

  const nuevo: ItemCarrito = {
    productoId: producto.id,
    nombre: producto.nombre,
    cantidad,
    precioUnitario: producto.precio_venta,
  };
  registro.items.push(nuevo);
  return { ok: true, item: { ...nuevo } };
}

/**
 * Devuelve una COPIA del carrito, no la referencia viva. Es importante para
 * generarProforma: entre calcular el total y armar el detalle hay awaits, y
 * con la referencia viva un agregarItem() en el medio dejaba la cotizacion
 * con una linea que no estaba sumada en el total.
 */
export function obtenerCarrito(telefono: string): ItemCarrito[] {
  limpiarExpirados();
  const registro = carritos.get(telefono);
  if (!registro || Date.now() > registro.expiraEn) return [];
  return registro.items.map((item) => ({ ...item }));
}

export function vaciarCarrito(telefono: string): void {
  carritos.delete(telefono);
}

/**
 * Toma el candado de "generando proforma" para un telefono.
 * Devuelve false si ya habia una generacion en curso: dos toques seguidos de
 * "Finalizar pedido" son dos mensajes con id distinto, asi que el dedupe no
 * los frena y sin el candado se creaban dos cotizaciones identicas.
 */
export function marcarGenerandoProforma(telefono: string): boolean {
  const ahora = Date.now();

  for (const [clave, expiraEn] of generandoProforma) {
    if (ahora > expiraEn) generandoProforma.delete(clave);
  }

  const enCurso = generandoProforma.get(telefono);
  if (enCurso !== undefined && ahora <= enCurso) return false;

  generandoProforma.set(telefono, ahora + VENTANA_GENERANDO_MS);
  return true;
}

export function liberarGenerandoProforma(telefono: string): void {
  generandoProforma.delete(telefono);
}
