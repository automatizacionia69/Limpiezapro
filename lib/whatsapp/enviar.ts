const GRAPH_API_VERSION = "v21.0";

/**
 * Tope por envio a la Graph API. El webhook procesa los mensajes del lote en
 * serie dentro de un presupuesto de tiempo acotado: un envio colgado no puede
 * quedarse esperando para siempre, porque arrastraria a todo el lote a que
 * Meta lo reintente y el cliente reciba las respuestas duplicadas.
 */
const TIMEOUT_ENVIO_MS = 8000;

function urlMensajes(): string | null {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!phoneNumberId) {
    console.error("Falta WHATSAPP_PHONE_NUMBER_ID.");
    return null;
  }
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
}

/** Trunca con "..." si excede el largo maximo que acepta el componente de WhatsApp. */
function recortar(texto: string, maximo: number): string {
  if (texto.length <= maximo) return texto;
  return `${texto.slice(0, maximo - 1).trimEnd()}…`;
}

async function enviarPayload(payload: Record<string, unknown>): Promise<boolean> {
  const url = urlMensajes();
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!url || !accessToken) {
    console.error("Falta WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_ACCESS_TOKEN.");
    return false;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_ENVIO_MS);

  try {
    const respuesta = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!respuesta.ok) {
      const detalle = await respuesta.text();
      console.error(`Error enviando WhatsApp (${respuesta.status}):`, detalle);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Error de red enviando WhatsApp:", error);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Envia un mensaje de texto por WhatsApp Cloud API.
 * No lanza en caso de fallo de red/API: el webhook debe responder 200 a Meta
 * igual, un error de envio no puede tumbar el procesamiento del mensaje.
 */
export async function enviarTexto(
  destinatario: string,
  texto: string
): Promise<boolean> {
  return enviarPayload({
    messaging_product: "whatsapp",
    to: destinatario,
    type: "text",
    text: { body: texto, preview_url: false },
  });
}

export interface FilaLista {
  id: string;
  titulo: string;
  descripcion?: string;
}

export interface SeccionLista {
  titulo: string;
  filas: FilaLista[];
}

/**
 * Envia un mensaje de lista interactiva (hasta 10 filas en total). WhatsApp
 * exige limites de largo por campo: titulo de fila <=24, descripcion <=72,
 * texto del boton <=20 — se recorta todo antes de mandar para no romper el
 * envio por un nombre de producto largo.
 */
export async function enviarListaInteractiva(
  destinatario: string,
  cuerpo: string,
  textoBoton: string,
  secciones: SeccionLista[]
): Promise<boolean> {
  return enviarPayload({
    messaging_product: "whatsapp",
    to: destinatario,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: recortar(cuerpo, 1024) },
      action: {
        button: recortar(textoBoton, 20),
        sections: secciones.map((seccion) => ({
          title: recortar(seccion.titulo, 24),
          rows: seccion.filas.map((fila) => ({
            id: fila.id,
            title: recortar(fila.titulo, 24),
            description: fila.descripcion ? recortar(fila.descripcion, 72) : undefined,
          })),
        })),
      },
    },
  });
}

export interface BotonReply {
  id: string;
  titulo: string;
}

/** Envia hasta 3 botones de respuesta rapida. */
export async function enviarBotones(
  destinatario: string,
  cuerpo: string,
  botones: BotonReply[]
): Promise<boolean> {
  return enviarPayload({
    messaging_product: "whatsapp",
    to: destinatario,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: recortar(cuerpo, 1024) },
      action: {
        buttons: botones.slice(0, 3).map((boton) => ({
          type: "reply",
          reply: { id: boton.id, title: recortar(boton.titulo, 20) },
        })),
      },
    },
  });
}
