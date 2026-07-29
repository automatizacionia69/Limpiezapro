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

let fallosSeguidos = 0;
let abiertoHasta = 0;

export function circuitoAbierto(): boolean {
  return Date.now() < abiertoHasta;
}

export function registrarExito(): void {
  fallosSeguidos = 0;
}

export function registrarFallo(esErrorDeAutenticacion: boolean): void {
  fallosSeguidos += 1;
  if (fallosSeguidos < UMBRAL_FALLOS) return;

  // Solo se avisa en la transicion cerrado -> abierto, no en cada falla
  // repetida mientras el circuito sigue abierto.
  const yaEstabaAbierto = Date.now() < abiertoHasta;
  abiertoHasta = Date.now() + VENTANA_ABIERTO_MS;
  if (!yaEstabaAbierto) {
    void avisarAlDueno(esErrorDeAutenticacion);
  }
}

async function avisarAlDueno(esErrorDeAutenticacion: boolean): Promise<void> {
  const numero = process.env.WHATSAPP_ADMIN_NUMERO;
  if (!numero) return;

  const mensaje = esErrorDeAutenticacion
    ? "El asistente de IA del chatbot dejó de responder — parece que venció " +
      "la clave de Gemini. Generá una nueva en Google AI Studio y actualizá " +
      "GEMINI_API_KEY. Mientras tanto el chatbot sigue funcionando con las " +
      "reglas normales."
    : "El asistente de IA del chatbot no está respondiendo (puede ser algo " +
      "temporal de Google). El chatbot sigue funcionando con las reglas " +
      "normales mientras tanto.";

  await enviarTexto(numero, mensaje);
}
