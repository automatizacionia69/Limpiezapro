/**
 * Rate limiter simple en memoria, por remitente (numero de WhatsApp).
 *
 * LIMITACION IMPORTANTE: el estado vive en memoria del proceso. En Vercel cada
 * instancia serverless tiene el suyo y se reinicia con frecuencia, asi que esto
 * frena spam accidental y abuso basico, pero NO es una defensa solida contra un
 * atacante decidido. Para eso hace falta un contador compartido (Upstash Redis,
 * Vercel KV) o rate limiting en el borde (WAF / middleware).
 */

const VENTANA_MS = 60_000;
const MAX_POR_VENTANA = 20;

const contadores = new Map<string, { conteo: number; expiraEn: number }>();

export function excedeLimite(clave: string): boolean {
  const ahora = Date.now();
  const registro = contadores.get(clave);

  if (!registro || ahora > registro.expiraEn) {
    contadores.set(clave, { conteo: 1, expiraEn: ahora + VENTANA_MS });
    return false;
  }

  registro.conteo += 1;
  if (registro.conteo > MAX_POR_VENTANA) return true;

  // Limpieza oportunista para que el Map no crezca sin control.
  if (contadores.size > 5000) {
    for (const [k, v] of contadores) {
      if (ahora > v.expiraEn) contadores.delete(k);
    }
  }

  return false;
}
