import { CANTIDAD_MAXIMA } from "./intent";
import { circuitoAbierto, registrarExito, registrarFallo } from "./circuitoIA";
import type { Turno } from "./memoriaConversacion";

/**
 * Respaldo de Gemini para cuando las reglas de intent.ts no entienden el
 * mensaje. Cliente REST directo (fetch), sin SDK nuevo, mismo estilo que
 * enviar.ts contra la Graph API de Meta. Nunca lanza excepcion: cualquier
 * problema (falta la key, timeout, HTTP no-ok, JSON invalido) se traduce en
 * registrarFallo() + null, para que el llamador siempre pueda caer de
 * vuelta a las reglas.
 */

const GEMINI_MODEL_DEFAULT = "gemini-flash-latest";
const TIMEOUT_MS = 6000;
const MAX_ITEMS_IA = 5;
/** Los modelos Gemini 3.x "piensan" antes de responder; sin tope esto puede
 * tardar 4.5s+ para una tarea de clasificacion simple. Un presupuesto chico
 * mantiene la latencia predecible sin perder la calidad de clasificacion
 * (probado: igual separa "papel y tambien lejia" en 2 items). */
const THINKING_BUDGET = 512;

export type IntentIA =
  | "consultar_stock"
  | "armar_pedido"
  | "fuera_de_catalogo"
  | "desconocido";

export interface ItemInterpretado {
  textoBusqueda: string;
  cantidad: number | null;
}

export interface InterpretacionGemini {
  intent: IntentIA;
  items: ItemInterpretado[];
}

const INTENTS_VALIDOS: IntentIA[] = [
  "consultar_stock",
  "armar_pedido",
  "fuera_de_catalogo",
  "desconocido",
];

const PROMPT_SISTEMA = `Sos el interprete de mensajes de un chatbot de WhatsApp de
LimpiezaPro, una distribuidora de articulos de limpieza en Piura, Peru.
Un sistema de reglas por palabras clave ya intento entender el mensaje del
cliente y no pudo — te llega a vos como respaldo.

Tu unico trabajo es INTERPRETAR el texto, nunca responder con datos de
precio, stock o nombres exactos de producto: eso lo resuelve otro sistema
contra la base de datos real. Vos solo entregas frases de busqueda.

Reglas:
- Tolerá errores de tipeo y lenguaje informal de Piura (ej. "kiero", "aparta
  nomas", "el de siempre").
- Si el mensaje pide mas de un producto (ej. "quiero papel y tambien lejia"),
  separalos en varios items.
- Si el mensaje hace referencia a algo mencionado antes en la conversacion
  (ej. "la de 4 litros" despues de haber hablado de lejia), usa el
  historial para resolver a que producto se refiere y arma el
  textoBusqueda completo (ej. "lejia 4 litros").
- Si el mensaje es un saludo, una pregunta fuera del catalogo de limpieza
  (horarios, ubicacion, formas de pago, etc.) o cualquier cosa que no sea
  buscar/pedir un producto, clasificalo como intent "fuera_de_catalogo" con
  items vacio.
- Si de verdad no se entiende nada, usa intent "desconocido" con items
  vacio.
- Si se entiende que busca/pide producto(s), usa intent "consultar_stock" o
  "armar_pedido" segun corresponda, con un item por producto distinto.
- cantidad es el numero de unidades si el cliente lo dijo, o null si no.`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    intent: {
      type: "STRING",
      enum: INTENTS_VALIDOS,
    },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          textoBusqueda: { type: "STRING" },
          cantidad: { type: "NUMBER", nullable: true },
        },
        required: ["textoBusqueda"],
      },
    },
  },
  required: ["intent", "items"],
};

function construirContents(texto: string, historial: Turno[]) {
  const turnos = historial.map((turno) => ({
    role: turno.rol === "usuario" ? "user" : "model",
    parts: [{ text: turno.texto }],
  }));

  return [...turnos, { role: "user", parts: [{ text: texto }] }];
}

function validarInterpretacion(valor: unknown): InterpretacionGemini | null {
  if (typeof valor !== "object" || valor === null) return null;
  const objeto = valor as Record<string, unknown>;

  const intent = objeto.intent;
  if (typeof intent !== "string" || !INTENTS_VALIDOS.includes(intent as IntentIA)) {
    return null;
  }

  const itemsCrudos = objeto.items;
  if (!Array.isArray(itemsCrudos)) return null;

  const items: ItemInterpretado[] = [];
  for (const itemCrudo of itemsCrudos.slice(0, MAX_ITEMS_IA)) {
    if (typeof itemCrudo !== "object" || itemCrudo === null) continue;
    const item = itemCrudo as Record<string, unknown>;

    const textoBusqueda = item.textoBusqueda;
    if (typeof textoBusqueda !== "string" || textoBusqueda.trim().length === 0) {
      continue;
    }

    let cantidad: number | null = null;
    if (typeof item.cantidad === "number" && Number.isSafeInteger(item.cantidad)) {
      if (item.cantidad > 0 && item.cantidad <= CANTIDAD_MAXIMA) {
        cantidad = item.cantidad;
      }
    }

    items.push({ textoBusqueda: textoBusqueda.trim(), cantidad });
  }

  return { intent: intent as IntentIA, items };
}

export async function interpretarConGemini(
  texto: string,
  historial: Turno[]
): Promise<InterpretacionGemini | null> {
  if (circuitoAbierto()) return null;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Sin key configurada: se trata igual que una clave vencida, para que
    // el aviso al dueno tambien cubra "nunca se configuro la clave".
    registrarFallo(true);
    return null;
  }

  const modelo = process.env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const respuesta = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PROMPT_SISTEMA }] },
        contents: construirContents(texto, historial),
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0,
          thinkingConfig: { thinkingBudget: THINKING_BUDGET },
        },
      }),
    });

    if (!respuesta.ok) {
      const esAuth = respuesta.status === 401 || respuesta.status === 403;
      console.error(`Error de Gemini (${respuesta.status}):`, await respuesta.text());
      registrarFallo(esAuth);
      return null;
    }

    const data = await respuesta.json();
    const textoJson = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof textoJson !== "string") {
      registrarFallo(false);
      return null;
    }

    const parsed: unknown = JSON.parse(textoJson);
    const interpretacion = validarInterpretacion(parsed);
    if (!interpretacion) {
      console.error("Respuesta de Gemini no conforme al esquema:", textoJson);
      registrarFallo(false);
      return null;
    }

    registrarExito();
    return interpretacion;
  } catch (error) {
    console.error("Error llamando a Gemini:", error);
    registrarFallo(false);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
