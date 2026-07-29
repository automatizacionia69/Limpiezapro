import type { ProductoEncontrado } from "./productos";

/**
 * Guarda el ultimo resultado de busqueda por telefono para poder reenviar
 * la misma lista despues de agregar un producto (WhatsApp no permite
 * seleccionar mas de una fila por mensaje de lista — esto simula "seguir
 * eligiendo del mismo listado" sin que el cliente tenga que reescribir la
 * busqueda). Misma limitacion de memoria que carrito.ts/rateLimit.ts.
 */

const VENTANA_MS = 30 * 60_000;

const busquedas = new Map<string, { productos: ProductoEncontrado[]; expiraEn: number }>();

export function guardarUltimaBusqueda(
  telefono: string,
  productos: ProductoEncontrado[]
): void {
  busquedas.set(telefono, { productos, expiraEn: Date.now() + VENTANA_MS });
}

export function obtenerUltimaBusqueda(telefono: string): ProductoEncontrado[] | null {
  const registro = busquedas.get(telefono);
  if (!registro || Date.now() > registro.expiraEn) return null;
  return registro.productos;
}
