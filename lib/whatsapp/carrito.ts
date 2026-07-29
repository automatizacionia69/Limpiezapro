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

const VENTANA_MS = 30 * 60_000;

const carritos = new Map<string, { items: ItemCarrito[]; expiraEn: number }>();

function limpiarExpirados() {
  const ahora = Date.now();
  for (const [telefono, registro] of carritos) {
    if (ahora > registro.expiraEn) carritos.delete(telefono);
  }
}

export function agregarItem(
  telefono: string,
  producto: { id: number; nombre: string; precio_venta: number | null }
): ItemCarrito {
  limpiarExpirados();

  const ahora = Date.now();
  let registro = carritos.get(telefono);
  if (!registro || ahora > registro.expiraEn) {
    registro = { items: [], expiraEn: ahora + VENTANA_MS };
    carritos.set(telefono, registro);
  }
  registro.expiraEn = ahora + VENTANA_MS;

  const existente = registro.items.find((i) => i.productoId === producto.id);
  if (existente) {
    existente.cantidad += 1;
    return existente;
  }

  const nuevo: ItemCarrito = {
    productoId: producto.id,
    nombre: producto.nombre,
    cantidad: 1,
    precioUnitario: producto.precio_venta ?? 0,
  };
  registro.items.push(nuevo);
  return nuevo;
}

export function obtenerCarrito(telefono: string): ItemCarrito[] {
  limpiarExpirados();
  const registro = carritos.get(telefono);
  if (!registro || Date.now() > registro.expiraEn) return [];
  return registro.items;
}

export function vaciarCarrito(telefono: string): void {
  carritos.delete(telefono);
}
