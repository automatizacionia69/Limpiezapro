import type { ProductoEncontrado } from "./productos";
import type { ItemCarrito } from "./carrito";
import type { ResultadoProforma } from "./proforma";

function formatearPrecio(precio: number | null): string {
  return precio === null ? "consultar precio" : `S/ ${precio.toFixed(2)}`;
}

function lineaProducto(p: ProductoEncontrado): string {
  return `• *${p.nombre}* — ${formatearPrecio(p.precio_venta)}`;
}

export function respuestaConsultaStock(productos: ProductoEncontrado[]): string {
  if (productos.length === 0) {
    return "No encontré ese producto en el catálogo. ¿Podrías escribir el nombre de otra forma?";
  }

  const lineas = productos.map(lineaProducto).join("\n");
  return `Esto encontré:\n\n${lineas}`;
}

export function respuestaArmarPedido(productos: ProductoEncontrado[]): string {
  if (productos.length === 0) {
    return "No encontré ese producto para armar el pedido. ¿Podrías escribir el nombre de otra forma?";
  }

  const lineas = productos.map(lineaProducto).join("\n");
  return `Encontré esto:\n\n${lineas}`;
}

export const RESPUESTA_DESCONOCIDO =
  "No entendí tu mensaje. Podés preguntarme por el precio o stock de un producto, por ejemplo: \"cuánto cuesta la lejía\".";

export const RESPUESTA_FUERA_DE_CATALOGO =
  "Por ahora solo puedo ayudarte con productos del catálogo. Si necesitás otra cosa, un vendedor te va a escribir en breve.";

export const RESPUESTA_TIPO_NO_SOPORTADO =
  "Por ahora solo puedo leer mensajes de texto. Escribime el nombre del producto que buscás, por ejemplo: \"tienen papel higiénico\".";

function lineaCarrito(item: ItemCarrito): string {
  return `• ${item.cantidad} x ${item.nombre} — S/ ${(item.cantidad * item.precioUnitario).toFixed(2)}`;
}

export const RESPUESTA_CARRITO_VACIO =
  "Todavía no agregaste productos. Buscá algo, por ejemplo: \"tienen lejía\".";

export function respuestaCarrito(items: ItemCarrito[]): string {
  if (items.length === 0) return RESPUESTA_CARRITO_VACIO;

  const lineas = items.map(lineaCarrito).join("\n");
  const total = items.reduce((acc, i) => acc + i.cantidad * i.precioUnitario, 0);
  return `Tu pedido hasta ahora:\n\n${lineas}\n\nSubtotal: S/ ${total.toFixed(2)}`;
}

export function respuestaItemAgregado(item: ItemCarrito): string {
  return `Agregado: ${item.nombre} x${item.cantidad}. ¿Qué querés hacer ahora?`;
}

export function respuestaProformaGenerada(resultado: ResultadoProforma): string {
  return (
    `¡Listo! Generé la cotización *${resultado.numero}*.\n\n` +
    `Subtotal: S/ ${resultado.subtotal.toFixed(2)}\n` +
    `IGV (18%): S/ ${resultado.igv.toFixed(2)}\n` +
    `Total: S/ ${resultado.total.toFixed(2)}\n\n` +
    `Un vendedor te va a contactar para confirmar el pedido y coordinar la entrega.`
  );
}

export const RESPUESTA_PROFORMA_ERROR =
  "Hubo un problema generando tu cotización. Un vendedor te va a contactar para ayudarte con el pedido.";
