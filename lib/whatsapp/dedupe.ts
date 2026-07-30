/**
 * Deduplicacion en memoria por id de mensaje de WhatsApp.
 *
 * Meta reintenta la entrega del webhook si no responde 200 a tiempo (o si
 * hay un error de red), lo que puede hacer llegar el MISMO mensaje mas de
 * una vez. Sin esto, un reintento se procesa de nuevo y el cliente recibe
 * la respuesta duplicada.
 *
 * El id se reserva en dos fases a proposito:
 * - "en_curso" mientras se procesa, para que un reintento simultaneo de Meta
 *   no genere dos respuestas iguales.
 * - "completado" recien cuando la respuesta se envio con exito.
 * Si el procesamiento falla (ej. el WHATSAPP_ACCESS_TOKEN vencio y todos los
 * envios devuelven error), el id se libera: asi el reintento de Meta tiene
 * otra oportunidad real de responderle al cliente en vez de descartarse como
 * duplicado y dejarlo en silencio para siempre.
 *
 * Misma limitacion que lib/whatsapp/rateLimit.ts: el estado vive en memoria
 * del proceso, asi que en Vercel cada instancia serverless tiene el suyo.
 * Frena los reintentos normales de Meta (van a la misma instancia en
 * segundos) pero no es una garantia global.
 */

const VENTANA_MS = 10 * 60_000;

/** Un id "en_curso" caduca rapido: si el proceso murio a mitad, el reintento debe poder tomarlo. */
const VENTANA_EN_CURSO_MS = 60_000;

const MAX_IDS = 5000;

type EstadoMensaje = "en_curso" | "completado";

const vistos = new Map<string, { estado: EstadoMensaje; expiraEn: number }>();

function limpiarExpirados(ahora: number) {
  for (const [id, registro] of vistos) {
    if (ahora > registro.expiraEn) vistos.delete(id);
  }
}

/**
 * Intenta reservar el mensaje para procesarlo.
 * Devuelve false si ya esta en curso o ya se respondio (hay que descartarlo).
 */
export function reservarMensaje(idMensaje: string): boolean {
  const ahora = Date.now();
  limpiarExpirados(ahora);

  if (vistos.has(idMensaje)) return false;

  // Al llegar al tope se desaloja lo mas viejo en vez de dejar de registrar:
  // si se dejara de registrar, el dedupe se apagaria en silencio justo
  // cuando hay mas trafico.
  while (vistos.size >= MAX_IDS) {
    const masViejo = vistos.keys().next();
    if (masViejo.done) break;
    vistos.delete(masViejo.value);
  }

  vistos.set(idMensaje, { estado: "en_curso", expiraEn: ahora + VENTANA_EN_CURSO_MS });
  return true;
}

/** El cliente ya recibio su respuesta: se bloquea cualquier reintento por la ventana completa. */
export function marcarMensajeCompletado(idMensaje: string): void {
  vistos.set(idMensaje, { estado: "completado", expiraEn: Date.now() + VENTANA_MS });
}

/** No se pudo responder: se libera el id para que el reintento de Meta pueda volver a intentarlo. */
export function liberarMensaje(idMensaje: string): void {
  const registro = vistos.get(idMensaje);
  if (registro?.estado === "en_curso") vistos.delete(idMensaje);
}
