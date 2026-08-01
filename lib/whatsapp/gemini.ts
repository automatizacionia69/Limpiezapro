import { CANTIDAD_MAXIMA } from "./intent";
import { circuitoAbierto, registrarExito, registrarFallo, type MotivoFallo } from "./circuitoIA";
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
/**
 * Historia de este numero: 6000ms se quedaba corto para mensajes con 2+
 * productos y se subio a 9000ms. Pero 9s no cabia en el presupuesto del
 * webhook de ese momento (limite por defecto de Vercel, 10s) y se bajo a
 * 3500ms. Desde que route.ts fijo maxDuration=60 y reserva explicitamente
 * MINIMO_PARA_GEMINI_MS=8000ms de presupuesto antes de siquiera intentar
 * llamar a Gemini, ese margen de 8s ya esta contemplado y protegido por
 * UMBRAL_CORTE_LOTE_MS — asi que 3500ms quedaba dejando sin usar ~4.5s de
 * presupuesto que ya estaban reservados. 7000ms deja 1s de margen bajo esa
 * reserva y le da lugar a los mensajes de 2+ productos (el caso que en la
 * practica mas necesita el tiempo extra) sin arriesgar el limite real de
 * la funcion. Lo que no llegue a tiempo sigue cayendo al camino de reglas,
 * que es lo que el diseño hibrido ya esperaba.
 */
const TIMEOUT_MS = 7000;
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
- "fuera_de_catalogo" es SOLO para mensajes que claramente no son un pedido
  de producto: saludos, preguntas de horarios/ubicacion/formas de pago,
  quejas, charla sin nada que buscar. Si el cliente dice algo con forma de
  "quiero/necesito/busco/tienen <X>", es intent "consultar_stock" o
  "armar_pedido" con ese <X> como textoBusqueda — SIEMPRE, aunque el
  nombre te suene raro o no te parezca un articulo de limpieza. Vos no
  decidis si existe en el catalogo: eso lo verifica despues la base de
  datos real: tu trabajo es solo extraer que es lo que esta pidiendo.
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
    await registrarFallo("autenticacion");
    return null;
  }

  const modelo = process.env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const inicio = Date.now();

  try {
    const respuesta = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
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
      const motivo: MotivoFallo =
        respuesta.status === 401 || respuesta.status === 403
          ? "autenticacion"
          : respuesta.status === 429
          ? "cuota"
          : "otro";
      console.error(`Error de Gemini (${respuesta.status}):`, await respuesta.text());
      await registrarFallo(motivo);
      return null;
    }

    const data = await respuesta.json();
    const textoJson = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof textoJson !== "string") {
      await registrarFallo("otro");
      return null;
    }

    const parsed: unknown = JSON.parse(textoJson);
    const interpretacion = validarInterpretacion(parsed);
    if (!interpretacion) {
      console.error("Respuesta de Gemini no conforme al esquema:", textoJson);
      await registrarFallo("otro");
      return null;
    }

    // La duracion importa: una respuesta lenta pero exitosa igual consume el
    // presupuesto del webhook, asi que una racha de lentas abre el circuito.
    const duracion = Date.now() - inicio;
    console.log(`[Gemini] Respuesta interpretada en ${duracion}ms.`);
    registrarExito(duracion);
    return interpretacion;
  } catch (error) {
    console.error("Error llamando a Gemini:", error);
    await registrarFallo("otro");
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
