/**
 * Estado conversacional minimo por telefono: solo guarda si se le esta
 * preguntando la cantidad de un producto que acaba de tocar en una lista,
 * para poder interpretar el siguiente mensaje de texto como esa respuesta.
 * Igual limitacion de memoria que carrito.ts/rateLimit.ts.
 */

const VENTANA_MS = 10 * 60_000;

const esperandoCantidad = new Map<string, { productoId: number; expiraEn: number }>();

export function pedirCantidadPara(telefono: string, productoId: number): void {
  esperandoCantidad.set(telefono, { productoId, expiraEn: Date.now() + VENTANA_MS });
}

/** Devuelve el producto pendiente sin borrarlo (para poder reintentar si la respuesta no es un numero valido). */
export function verProductoPendienteDeCantidad(telefono: string): number | null {
  const registro = esperandoCantidad.get(telefono);
  if (!registro || Date.now() > registro.expiraEn) return null;
  return registro.productoId;
}

export function limpiarPendienteDeCantidad(telefono: string): void {
  esperandoCantidad.delete(telefono);
}
