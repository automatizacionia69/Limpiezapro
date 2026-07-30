import { enviarTexto } from "./enviar";

/**
 * Circuit breaker a nivel de modulo para las llamadas a Gemini: es un unico
 * recurso externo compartido (no por telefono, como carrito.ts). Tras varias
 * fallas seguidas se deja de llamar a la red por un rato, para no acumular
 * pedidos lentos durante una caida y responder siempre con las reglas.
 *
 * Ademas de las fallas, se vigila la LATENCIA: una llamada lenta pero exitosa
 * tambien es un problema (consume el presupuesto de tiempo de la funcion y
 * puede hacer que Meta reintente el webhook y el cliente reciba todo
 * duplicado). Antes, esas llamadas llamaban a registrarExito() y reseteaban el
 * contador, asi que con Gemini respondiendo lento pero bien el circuito no
 * abria nunca.
 *
 * Misma limitacion que rateLimit.ts/dedupe.ts: vive en memoria del proceso,
 * asi que en Vercel cada instancia serverless tiene el suyo.
 */

const UMBRAL_FALLOS = 3;
const VENTANA_ABIERTO_MS = 60_000;

/** Una respuesta que tarda mas que esto se considera "lenta" aunque haya salido bien. */
const UMBRAL_LENTITUD_MS = 3_000;

/** Respuestas lentas seguidas que abren el circuito. */
const UMBRAL_LENTAS = 3;

/** Minimo entre avisos al dueno: una caida larga (ej. cuota diaria agotada)
 * reabre el circuito cada VENTANA_ABIERTO_MS, pero no tiene sentido mandar
 * un WhatsApp nuevo cada vez — con uno cada 30 min alcanza para que se
 * entere sin inundarlo de mensajes el resto del dia. */
const VENTANA_ENTRE_AVISOS_MS = 30 * 60_000;

export type MotivoFallo = "autenticacion" | "cuota" | "otro";

let fallosSeguidos = 0;
let lentasSeguidas = 0;
let abiertoHasta = 0;
let ultimoAvisoEn = 0;

export function circuitoAbierto(): boolean {
  return Date.now() < abiertoHasta;
}

/**
 * Registra una llamada exitosa. `duracionMs` es opcional solo por comodidad:
 * pasandola, una racha de respuestas lentas tambien abre el circuito.
 */
export function registrarExito(duracionMs?: number): void {
  fallosSeguidos = 0;

  if (duracionMs === undefined || duracionMs < UMBRAL_LENTITUD_MS) {
    lentasSeguidas = 0;
    return;
  }

  lentasSeguidas += 1;
  if (lentasSeguidas < UMBRAL_LENTAS) return;

  lentasSeguidas = 0;
  abiertoHasta = Date.now() + VENTANA_ABIERTO_MS;
  console.warn(
    `Circuito de IA abierto por latencia sostenida (${UMBRAL_LENTAS} respuestas ` +
      `de mas de ${UMBRAL_LENTITUD_MS}ms). Se responde con reglas por ` +
      `${VENTANA_ABIERTO_MS / 1000}s.`
  );
}

export async function registrarFallo(motivo: MotivoFallo): Promise<void> {
  fallosSeguidos += 1;
  if (fallosSeguidos < UMBRAL_FALLOS) return;

  abiertoHasta = Date.now() + VENTANA_ABIERTO_MS;

  const ahora = Date.now();
  if (ahora - ultimoAvisoEn < VENTANA_ENTRE_AVISOS_MS) return;

  // Se espera el envio y ultimoAvisoEn se marca SOLO si salio bien: en
  // serverless una promesa suelta (void) puede no ejecutarse despues del
  // return, y marcar antes consumia la ventana de 30 min sin haber avisado.
  const enviado = await avisarAlDueno(motivo);
  if (enviado) ultimoAvisoEn = ahora;
}

/**
 * Avisa al dueno por WhatsApp. Devuelve si el envio salio bien.
 *
 * ⚠️ PRODUCCION: la Cloud API solo permite texto libre dentro de la ventana de
 * 24h desde el ultimo mensaje del destinatario. Si el dueno no le escribio al
 * numero del negocio en las ultimas 24h, este envio falla con el error 131047 y
 * el aviso no llega. Para que sea confiable hace falta una PLANTILLA APROBADA
 * (message template) o un canal que no dependa de esa ventana (mail, Telegram,
 * un panel de alertas en el ERP).
 */
async function avisarAlDueno(motivo: MotivoFallo): Promise<boolean> {
  const numero = process.env.WHATSAPP_ADMIN_NUMERO;
  if (!numero) return false;

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

  return enviarTexto(numero, mensajes[motivo]);
}
