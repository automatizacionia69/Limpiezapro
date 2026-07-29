import { NextRequest, NextResponse } from "next/server";
import { detectarIntencion } from "@/lib/whatsapp/intent";
import {
  buscarProductos,
  obtenerProductoPorId,
  type ProductoEncontrado,
} from "@/lib/whatsapp/productos";
import { firmaEsValida } from "@/lib/whatsapp/firma";
import { excedeLimite } from "@/lib/whatsapp/rateLimit";
import {
  enviarTexto,
  enviarListaInteractiva,
  enviarBotones,
} from "@/lib/whatsapp/enviar";
import { yaProcesado } from "@/lib/whatsapp/dedupe";
import { agregarItem, obtenerCarrito, vaciarCarrito } from "@/lib/whatsapp/carrito";
import { generarProforma } from "@/lib/whatsapp/proforma";
import {
  respuestaConsultaStock,
  RESPUESTA_DESCONOCIDO,
  RESPUESTA_TIPO_NO_SOPORTADO,
  RESPUESTA_CARRITO_VACIO,
  respuestaCarrito,
  respuestaItemAgregado,
  respuestaProformaGenerada,
  RESPUESTA_PROFORMA_ERROR,
} from "@/lib/whatsapp/respuestas";

/** Tope de mensajes procesados por llamada al webhook: Meta puede agrupar varios. */
const MAX_MENSAJES_POR_LOTE = 20;

/** Tipos de mensaje a los que no tiene sentido responder (reacciones a mensajes previos). */
const TIPOS_SIN_RESPUESTA = new Set(["reaction"]);

/** ids de los botones de accion que se ofrecen despues de agregar un producto. */
const BOTON_SEGUIR = "seguir";
const BOTON_VER_CARRITO = "ver_carrito";
const BOTON_FINALIZAR = "finalizar";

const esDesarrollo = process.env.NODE_ENV !== "production";

/** Enmascara un numero para logs: 51987654321 -> 519****4321 */
function enmascarar(numero: string): string {
  if (numero.length <= 7) return "****";
  return `${numero.slice(0, 3)}****${numero.slice(-4)}`;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return new NextResponse(null, { status: 403 });
}

export async function POST(request: NextRequest) {
  // El body se lee crudo: el HMAC de Meta se calcula sobre estos bytes
  // exactos, asi que no se puede parsear antes de validar la firma.
  const rawBody = await request.text();
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  if (appSecret) {
    const firma = request.headers.get("x-hub-signature-256");
    if (!firmaEsValida(rawBody, firma, appSecret)) {
      console.warn("Webhook rechazado: firma X-Hub-Signature-256 invalida.");
      return new NextResponse(null, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    console.error(
      "Webhook rechazado: falta WHATSAPP_APP_SECRET en produccion."
    );
    return new NextResponse(null, { status: 500 });
  } else {
    console.warn(
      "WHATSAPP_APP_SECRET no configurado: verificacion de firma OMITIDA (solo desarrollo)."
    );
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.warn("Webhook rechazado: body no es JSON valido.");
    return new NextResponse(null, { status: 400 });
  }

  // El payload completo trae telefono y nombre del cliente: solo se vuelca
  // entero en desarrollo, para no dejar datos personales en los logs de Vercel.
  if (esDesarrollo) {
    console.log("Webhook de WhatsApp recibido:", JSON.stringify(body, null, 2));
  }

  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const mensajes = (value?.messages ?? []).slice(0, MAX_MENSAJES_POR_LOTE);
  const nombrePerfilRaw = value?.contacts?.[0]?.profile?.name;
  const nombrePerfil = typeof nombrePerfilRaw === "string" ? nombrePerfilRaw : null;

  for (const mensaje of mensajes) {
    try {
      await procesarMensaje(mensaje, nombrePerfil);
    } catch (error) {
      console.error("Error procesando mensaje de WhatsApp:", error);
    }
  }

  // Siempre 200: si Meta ve un error reintenta la entrega, y como cada
  // mensaje ya se maneja con su propio try/catch, un reintento solo
  // duplicaria envios en vez de arreglar nada.
  return NextResponse.json({ status: "ok" }, { status: 200 });
}

async function procesarMensaje(
  mensaje: Record<string, unknown>,
  nombrePerfil: string | null
) {
  const id = typeof mensaje.id === "string" ? mensaje.id : null;
  if (id && yaProcesado(id)) {
    console.warn(`Mensaje repetido (reintento de Meta), omitido: ${id}`);
    return;
  }

  const remitente = String(mensaje.from ?? "");
  if (!remitente) return;

  if (excedeLimite(remitente)) {
    console.warn(`Mensaje descartado por rate limit: ${enmascarar(remitente)}`);
    return;
  }

  const tipo = mensaje.type;

  if (tipo === "interactive") {
    await procesarInteractivo(mensaje, remitente, nombrePerfil);
    return;
  }

  if (tipo !== "text") {
    if (typeof tipo === "string" && !TIPOS_SIN_RESPUESTA.has(tipo)) {
      console.log(`Mensaje de tipo "${tipo}" (de ${enmascarar(remitente)}), no soportado.`);
      await enviarTexto(remitente, RESPUESTA_TIPO_NO_SOPORTADO);
    }
    return;
  }

  const texto = (mensaje.text as { body?: unknown } | undefined)?.body;
  if (typeof texto !== "string" || texto.trim().length === 0) {
    console.warn(`Mensaje de texto sin body valido (de ${enmascarar(remitente)}).`);
    return;
  }

  const resultado = detectarIntencion(texto);
  console.log(
    `Intencion detectada (de ${enmascarar(remitente)}):`,
    resultado.intent
  );

  const requiereBusqueda =
    (resultado.intent === "consultar_stock" ||
      resultado.intent === "armar_pedido") &&
    resultado.productoTexto;

  if (!requiereBusqueda) {
    await enviarTexto(remitente, RESPUESTA_DESCONOCIDO);
    return;
  }

  const productos = await buscarProductos(resultado.productoTexto!);
  console.log(
    `Productos encontrados para "${resultado.productoTexto}": ${productos.length}`
  );
  if (esDesarrollo) console.log(productos);

  if (productos.length === 0) {
    await enviarTexto(remitente, respuestaConsultaStock(productos));
    return;
  }

  await enviarListaProductos(remitente, productos);
}

/** Maximo de filas por mensaje de lista interactiva: limite duro de la API de WhatsApp. */
const MAX_FILAS_POR_LISTA = 10;

async function enviarListaProductos(
  destinatario: string,
  productos: ProductoEncontrado[]
) {
  const filas = productos.map((p) => ({
    id: `add_${p.id}`,
    titulo: p.nombre,
    descripcion: `${
      p.precio_venta !== null ? `S/ ${p.precio_venta.toFixed(2)}` : "Consultar precio"
    } · ${p.cantidad > 0 ? `${p.cantidad} ${p.unidad}` : "sin stock"}`,
  }));

  const lotes: (typeof filas)[] = [];
  for (let i = 0; i < filas.length; i += MAX_FILAS_POR_LISTA) {
    lotes.push(filas.slice(i, i + MAX_FILAS_POR_LISTA));
  }

  let huboFallo = false;

  for (let i = 0; i < lotes.length; i++) {
    const cuerpo =
      lotes.length > 1
        ? `Esto encontré (${i + 1}/${lotes.length}). Tocá un producto para agregarlo a tu pedido:`
        : "Esto encontré. Tocá un producto para agregarlo a tu pedido:";

    const enviado = await enviarListaInteractiva(destinatario, cuerpo, "Ver productos", [
      { titulo: "Resultados", filas: lotes[i] },
    ]);

    if (!enviado) huboFallo = true;
  }

  if (huboFallo) {
    // Fallback a texto plano si algun mensaje interactivo no se pudo enviar.
    await enviarTexto(destinatario, respuestaConsultaStock(productos));
  }
}

async function enviarBotonesAccion(destinatario: string) {
  await enviarBotones(destinatario, "Elegí una opción:", [
    { id: BOTON_SEGUIR, titulo: "Seguir comprando" },
    { id: BOTON_VER_CARRITO, titulo: "Ver carrito" },
    { id: BOTON_FINALIZAR, titulo: "Finalizar pedido" },
  ]);
}

async function procesarInteractivo(
  mensaje: Record<string, unknown>,
  remitente: string,
  nombrePerfil: string | null
) {
  const interactive = mensaje.interactive as Record<string, unknown> | undefined;
  if (!interactive) return;

  if (interactive.type === "list_reply") {
    const listReply = interactive.list_reply as { id?: unknown } | undefined;
    const id = listReply?.id;
    if (typeof id === "string" && id.startsWith("add_")) {
      const productoId = Number(id.slice("add_".length));
      if (Number.isFinite(productoId)) {
        await agregarProductoAlCarrito(remitente, productoId);
      }
    }
    return;
  }

  if (interactive.type === "button_reply") {
    const buttonReply = interactive.button_reply as { id?: unknown } | undefined;
    const id = buttonReply?.id;

    if (id === BOTON_SEGUIR) {
      await enviarTexto(remitente, "Decime qué otro producto buscás.");
      return;
    }

    if (id === BOTON_VER_CARRITO) {
      const items = obtenerCarrito(remitente);
      await enviarTexto(remitente, respuestaCarrito(items));
      if (items.length > 0) await enviarBotonesAccion(remitente);
      return;
    }

    if (id === BOTON_FINALIZAR) {
      const items = obtenerCarrito(remitente);
      if (items.length === 0) {
        await enviarTexto(remitente, RESPUESTA_CARRITO_VACIO);
        return;
      }

      const resultado = await generarProforma(remitente, nombrePerfil, items);
      if (resultado) {
        vaciarCarrito(remitente);
        await enviarTexto(remitente, respuestaProformaGenerada(resultado));
      } else {
        await enviarTexto(remitente, RESPUESTA_PROFORMA_ERROR);
      }
      return;
    }
  }
}

async function agregarProductoAlCarrito(remitente: string, productoId: number) {
  const producto = await obtenerProductoPorId(productoId);
  if (!producto) {
    await enviarTexto(remitente, "Ese producto ya no está disponible.");
    return;
  }

  const item = agregarItem(remitente, producto);
  await enviarTexto(remitente, respuestaItemAgregado(item));
  await enviarBotonesAccion(remitente);
}
