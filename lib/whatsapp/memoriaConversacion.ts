/**
 * Historial corto de la conversacion actual por numero de telefono, para que
 * Gemini pueda resolver referencias ("la de 4 litros") sin depender de una
 * tabla nueva. Mismo patron Map+TTL que carrito.ts/ultimaBusqueda.ts/estado.ts.
 */

export interface Turno {
  rol: "usuario" | "bot";
  texto: string;
}

const VENTANA_MS = 30 * 60_000;
const MAX_TURNOS = 8;

const historiales = new Map<string, { turnos: Turno[]; expiraEn: number }>();

export function agregarTurno(
  telefono: string,
  rol: Turno["rol"],
  texto: string
): void {
  const ahora = Date.now();
  let registro = historiales.get(telefono);
  if (!registro || ahora > registro.expiraEn) {
    registro = { turnos: [], expiraEn: ahora + VENTANA_MS };
    historiales.set(telefono, registro);
  }
  registro.expiraEn = ahora + VENTANA_MS;

  registro.turnos.push({ rol, texto });
  if (registro.turnos.length > MAX_TURNOS) registro.turnos.shift();
}

export function obtenerHistorial(telefono: string): Turno[] {
  const registro = historiales.get(telefono);
  if (!registro || Date.now() > registro.expiraEn) return [];
  return registro.turnos;
}
