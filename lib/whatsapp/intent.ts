export type Intent = "consultar_stock" | "armar_pedido" | "desconocido";

export interface IntentResult {
  intent: Intent;
  productoTexto: string | null;
  cantidad: number | null;
}

const PALABRAS_CONSULTA = [
  "cuanto cuesta",
  "cuanto vale",
  "cuanto tienen",
  "cuantos hay",
  "cuantas hay",
  "hay stock",
  "tienen stock",
  "queda",
  "quedan",
  "precio de",
  "precio",
  "tienen",
  "hay",
];

const PALABRAS_PEDIDO = [
  "quiero pedir",
  "quiero comprar",
  "quiero llevar",
  "me llevo",
  "necesito",
  "encargar",
  "encargame",
  "mandame",
  "enviame",
  "aparta",
  "resérvame",
  "reservame",
  "pedido de",
];

const PALABRAS_A_LIMPIAR = [
  ...PALABRAS_PEDIDO,
  ...PALABRAS_CONSULTA,
  "hola",
  "buenas",
  "buenos dias",
  "buenas tardes",
  "buenas noches",
  "por favor",
  "porfa",
  "de",
  "para",
  "la",
  "el",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
];

const MAPA_ACENTOS: Record<string, string> = {
  á: "a",
  é: "e",
  í: "i",
  ó: "o",
  ú: "u",
  ñ: "n",
};

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .split("")
    .map((c) => MAPA_ACENTOS[c] ?? c)
    .join("")
    .trim();
}

export function detectarIntencion(textoOriginal: string): IntentResult {
  const texto = normalizar(textoOriginal);

  const esPedido = PALABRAS_PEDIDO.some((p) => texto.includes(normalizar(p)));
  const esConsulta =
    !esPedido && PALABRAS_CONSULTA.some((p) => texto.includes(normalizar(p)));

  let intent: Intent = "desconocido";
  if (esPedido) intent = "armar_pedido";
  else if (esConsulta) intent = "consultar_stock";

  const cantidad = extraerCantidad(texto);

  const productoTexto = intent === "desconocido" ? null : extraerProducto(texto);

  return { intent, productoTexto, cantidad };
}

/** Cantidad maxima aceptada en un pedido por WhatsApp. */
export const CANTIDAD_MAXIMA = 10_000;

/**
 * Extrae la cantidad pedida y la valida antes de que llegue a la base de datos.
 * El texto lo controla el cliente, asi que se descarta lo que no sea un entero
 * positivo dentro de un rango razonable (evita 0, desbordes y numeros absurdos
 * tipo "quiero 99999999999999 cajas").
 */
function extraerCantidad(texto: string): number | null {
  const match = texto.match(/\d+/);
  if (!match) return null;

  const valor = Number.parseInt(match[0], 10);

  if (!Number.isSafeInteger(valor)) return null;
  if (valor <= 0 || valor > CANTIDAD_MAXIMA) return null;

  return valor;
}

function extraerProducto(texto: string): string | null {
  let limpio = texto;

  for (const frase of PALABRAS_A_LIMPIAR) {
    const normalizada = normalizar(frase);
    const regex = new RegExp(`\\b${normalizada}\\b`, "g");
    limpio = limpio.replace(regex, " ");
  }

  limpio = limpio
    .replace(/\d+/g, " ")
    .replace(/[¿?¡!.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return limpio.length > 0 ? limpio : null;
}
