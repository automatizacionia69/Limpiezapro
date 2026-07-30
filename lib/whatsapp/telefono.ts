/**
 * Normalizacion de numeros de telefono.
 *
 * El remitente de WhatsApp llega siempre en formato internacional sin signos
 * ("51987654321"), pero en el ERP el telefono del cliente se escribe a mano y
 * en texto libre ("987 654 321", "+51 987-654-321", "987654321"). Comparar
 * ambos tal cual nunca matchea, asi que todo se reduce a una forma canonica:
 * solo digitos, sin el prefijo de pais.
 */

/** Codigo de pais de Peru: los numeros de WhatsApp llegan con este prefijo. */
const PREFIJO_PAIS = "51";

/** Largo de un movil peruano sin prefijo de pais (9 digitos: 9XXXXXXXX). */
const LARGO_LOCAL = 9;

/** Deja solo los digitos y quita el prefijo de pais si el numero es mas largo que uno local. */
export function normalizarTelefono(valor: string | null | undefined): string {
  if (!valor) return "";

  let digitos = valor.replace(/\D/g, "");
  if (digitos.length > LARGO_LOCAL && digitos.startsWith(PREFIJO_PAIS)) {
    digitos = digitos.slice(PREFIJO_PAIS.length);
  }

  return digitos;
}

/** true si los dos valores son el mismo telefono, aunque esten escritos distinto. */
export function mismoTelefono(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const normalizadoA = normalizarTelefono(a);
  const normalizadoB = normalizarTelefono(b);
  return normalizadoA.length > 0 && normalizadoA === normalizadoB;
}
