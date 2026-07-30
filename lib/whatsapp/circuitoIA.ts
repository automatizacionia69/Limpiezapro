import { enviarTexto } from "./enviar";

/**
 * Circuit breaker a nivel de modulo para las llamadas a Gemini: es un unico
 * recurso externo compartido (no por telefono, como carrito.ts). Tras varias
 * fallas seguidas se deja de llamar a la red por un rato, para no acumular
 * pedidos lentos durante una caida y responder siempre con las reglas.
 *
 * Misma limitacion que rateLimit.ts/dedupe.ts: vive en memoria del proceso,
 * asi que en Vercel cada instancia serverless tiene el suyo.
 */

const UMBRAL_FALLOS = 3;
const VENTANA_ABIERTO_MS = 60_000;
/** Minimo entre avisos al dueno: una caida larga (ej. cuota diaria agotada)
 * reabre el circuito cada VENTANA_ABIERTO_MS, pero no tiene sentido mandar
 * un WhatsApp nuevo cada vez — con uno cada 30 min alcanza para que se
 * entere sin inundarlo de mensajes el resto del dia. */
const VENTANA_ENTRE_AVISOS_MS = 30 * 60_000;

export type MotivoFallo = "autenticacion" | "cuota" | "otro";

let fallosSeguidos = 0;
let abiertoHasta = 0;
let ultimoAvisoEn = 0;

export function circuitoAbierto(): boolean {
  return Date.now() < abiertoHasta;
}

export function registrarExito(): void {
  fallosSeguidos = 0;
}

export function registrarFallo(motivo: MotivoFallo): void {
  fallosSeguidos += 1;
  if (fallosSeguidos < UMBRAL_FALLOS) return;

  abiertoHasta = Date.now() + VENTANA_ABIERTO_MS;

  const ahora = Date.now();
  if (ahora - ultimoAvisoEn >= VENTANA_ENTRE_AVISOS_MS) {
    ultimoAvisoEn = ahora;
    void avisarAlDueno(motivo);
  }
}

async function avisarAlDueno(motivo: MotivoFallo): Promise<void> {
  const numero = process.env.WHATSAPP_ADMIN_NUMERO;
  if (!numero) return;

  const mensajes: Record<MotivoFallo, string> = {
    autenticacion:
      "El asistente de IA del chatbot dejó de responder — parece que venció " +
      "la clave de Gemini. Generá una nueva en Google AI Studio y actualizá " +
      "GEMINI_API_KEY. Mientras tanto el chatbot sigue funcionando con las " +
      "reglas normales.",
    cuota:
      "El asistente de IA del chatbot se quedó sin cuota gratuita de Gemini " +
      "por hoy (se recupera mañana, o podés activar facturación en Google " +
      "AI Studio para no depender del límite gratis). Mientras tanto el " +
      "chatbot sigue funcionando con las reglas normales.",
    otro:
      "El asistente de IA del chatbot no está respondiendo (puede ser algo " +
      "temporal de Google). El chatbot sigue funcionando con las reglas " +
      "normales mientras tanto.",
  };

  await enviarTexto(numero, mensajes[motivo]);
}
