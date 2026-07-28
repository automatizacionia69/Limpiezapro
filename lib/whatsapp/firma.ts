import crypto from "crypto";

/**
 * Valida el header X-Hub-Signature-256 que Meta envia en cada webhook.
 * La firma es un HMAC-SHA256 del cuerpo crudo del request, usando el
 * App Secret de la app de Meta como clave.
 *
 * Debe calcularse sobre el body EXACTO tal como llego (string sin parsear):
 * cualquier reserializacion del JSON cambia el hash y la firma no cuadra.
 */
export function firmaEsValida(
  rawBody: string,
  firmaHeader: string | null,
  appSecret: string
): boolean {
  if (!firmaHeader) return false;

  const [algoritmo, hashRecibido] = firmaHeader.split("=");
  if (algoritmo !== "sha256" || !hashRecibido) return false;

  const hashEsperado = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("hex");

  const bufRecibido = Buffer.from(hashRecibido, "hex");
  const bufEsperado = Buffer.from(hashEsperado, "hex");

  // timingSafeEqual exige buffers del mismo largo; un hex invalido o de
  // otro tamano se descarta aca antes de comparar.
  if (bufRecibido.length !== bufEsperado.length) return false;

  return crypto.timingSafeEqual(bufRecibido, bufEsperado);
}
