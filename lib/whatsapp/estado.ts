/**
 * Estado conversacional minimo por telefono: solo guarda si se le esta
 * preguntando la cantidad de un producto que acaba de tocar en una lista,
 * para poder interpretar el siguiente mensaje de texto como esa respuesta.
 * Igual limitacion de memoria que carrito.ts/rateLimit.ts.
 */

/**
 * Mismo TTL que carrito.ts / ultimaBusqueda.ts / memoriaConversacion.ts: con
 * 10 min el pendiente vencia antes que el carrito y una demora de 11 minutos
 * dejaba al cliente con el carrito vivo pero la pregunta de cantidad perdida.
 */
const VENTANA_MS = 30 * 60_000;

const esperandoCantidad = new Map<
  string,
  { productoId: number; intentos: number; expiraEn: number }
>();

/**
 * Cantidad que el cliente ya menciono en su mensaje ("necesito 20 lejias"),
 * para no volver a preguntarla de cero cuando hay varios productos que
 * matchean y tiene que elegir uno de la lista.
 */
const cantidadesSugeridas = new Map<string, { cantidad: number; expiraEn: number }>();

export function pedirCantidadPara(telefono: string, productoId: number): void {
  esperandoCantidad.set(telefono, {
    productoId,
    intentos: 0,
    expiraEn: Date.now() + VENTANA_MS,
  });
}

/** Devuelve el producto pendiente sin borrarlo (para poder reintentar si la respuesta no es un numero valido). */
export function verProductoPendienteDeCantidad(telefono: string): number | null {
  const registro = esperandoCantidad.get(telefono);
  if (!registro || Date.now() > registro.expiraEn) return null;
  return registro.productoId;
}

/**
 * Cuenta un intento fallido de responder la cantidad y refresca el TTL (el
 * reloj arranca de nuevo con cada reintento, no desde la primera pregunta).
 * Devuelve la cantidad de intentos fallidos acumulados.
 */
export function registrarIntentoFallidoDeCantidad(telefono: string): number {
  const registro = esperandoCantidad.get(telefono);
  if (!registro) return 0;

  registro.intentos += 1;
  registro.expiraEn = Date.now() + VENTANA_MS;
  return registro.intentos;
}

export function limpiarPendienteDeCantidad(telefono: string): void {
  esperandoCantidad.delete(telefono);
}

export function guardarCantidadSugerida(telefono: string, cantidad: number): void {
  cantidadesSugeridas.set(telefono, { cantidad, expiraEn: Date.now() + VENTANA_MS });
}

export function verCantidadSugerida(telefono: string): number | null {
  const registro = cantidadesSugeridas.get(telefono);
  if (!registro || Date.now() > registro.expiraEn) {
    cantidadesSugeridas.delete(telefono);
    return null;
  }
  return registro.cantidad;
}

export function limpiarCantidadSugerida(telefono: string): void {
  cantidadesSugeridas.delete(telefono);
}
