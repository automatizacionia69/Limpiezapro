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

/**
 * Tope de mensajes conversacionales por minuto. El flujo de compra real cuesta
 * 2 mensajes entrantes por producto (tocar la fila + escribir la cantidad), asi
 * que con 20 un pedido de 10 productos se cortaba justo al finalizar.
 */
const MAX_POR_VENTANA = 40;

/**
 * Tope aparte, mas alto, para los mensajes que son parte del flujo de compra
 * (toques de boton/lista y respuestas de cantidad). No se cuentan junto con los
 * conversacionales para no cortar una compra a mitad, pero siguen teniendo un
 * techo para que un cliente tocando botones sin parar no quede sin limite.
 */
const MAX_FLUJO_POR_VENTANA = 120;

interface ResultadoLimite {
  excede: boolean;
  /** true una sola vez por ventana: sirve para avisarle al cliente sin convertir el aviso en spam. */
  avisar: boolean;
}

const contadores = new Map<
  string,
  { conteo: number; expiraEn: number; avisado: boolean }
>();

/**
 * Cuenta el mensaje y dice si hay que descartarlo.
 * `esFlujoDeCompra` usa un contador y un tope separados (ver arriba).
 */
export function evaluarLimite(
  clave: string,
  esFlujoDeCompra = false
): ResultadoLimite {
  const ahora = Date.now();
  const claveReal = esFlujoDeCompra ? `flujo:${clave}` : clave;
  const maximo = esFlujoDeCompra ? MAX_FLUJO_POR_VENTANA : MAX_POR_VENTANA;

  const registro = contadores.get(claveReal);

  if (!registro || ahora > registro.expiraEn) {
    contadores.set(claveReal, {
      conteo: 1,
      expiraEn: ahora + VENTANA_MS,
      avisado: false,
    });
    return { excede: false, avisar: false };
  }

  registro.conteo += 1;

  if (registro.conteo > maximo) {
    const avisar = !registro.avisado;
    registro.avisado = true;
    return { excede: true, avisar };
  }

  // Limpieza oportunista para que el Map no crezca sin control.
  if (contadores.size > 5000) {
    for (const [k, v] of contadores) {
      if (ahora > v.expiraEn) contadores.delete(k);
    }
  }

  return { excede: false, avisar: false };
}
