/**
 * Deduplicacion en memoria por id de mensaje de WhatsApp.
 *
 * Meta reintenta la entrega del webhook si no responde 200 a tiempo (o si
 * hay un error de red), lo que puede hacer llegar el MISMO mensaje mas de
 * una vez. Sin esto, un reintento se procesa de nuevo y el cliente recibe
 * la respuesta duplicada.
 *
 * Misma limitacion que lib/whatsapp/rateLimit.ts: el estado vive en memoria
 * del proceso, asi que en Vercel cada instancia serverless tiene el suyo.
 * Frena los reintentos normales de Meta (van a la misma instancia en
 * segundos) pero no es una garantia global.
 */

const VENTANA_MS = 10 * 60_000;
const MAX_IDS = 5000;

const vistos = new Map<string, number>();

export function yaProcesado(idMensaje: string): boolean {
  const ahora = Date.now();

  for (const [id, expiraEn] of vistos) {
    if (ahora > expiraEn) vistos.delete(id);
  }

  if (vistos.has(idMensaje)) return true;

  if (vistos.size < MAX_IDS) {
    vistos.set(idMensaje, ahora + VENTANA_MS);
  }

  return false;
}
