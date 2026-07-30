import { NextRequest, NextResponse } from "next/server";
import { detectarIntencion, CANTIDAD_MAXIMA } from "@/lib/whatsapp/intent";
import {
  buscarProductos,
  buscarProductosPorTerminos,
  obtenerProductoPorId,
  type ProductoEncontrado,
} from "@/lib/whatsapp/productos";
import { firmaEsValida } from "@/lib/whatsapp/firma";
import { evaluarLimite } from "@/lib/whatsapp/rateLimit";
import {
  enviarTexto,
  enviarListaInteractiva,
  enviarBotones,
  type FilaLista,
} from "@/lib/whatsapp/enviar";
import {
  reservarMensaje,
  marcarMensajeCompletado,
  liberarMensaje,
} from "@/lib/whatsapp/dedupe";
import {
  agregarItem,
  obtenerCarrito,
  vaciarCarrito,
  marcarGenerandoProforma,
  liberarGenerandoProforma,
} from "@/lib/whatsapp/carrito";
import { guardarUltimaBusqueda, obtenerUltimaBusqueda } from "@/lib/whatsapp/ultimaBusqueda";
import {
  pedirCantidadPara,
  verProductoPendienteDeCantidad,
  limpiarPendienteDeCantidad,
  registrarIntentoFallidoDeCantidad,
  guardarCantidadSugerida,
  verCantidadSugerida,
  limpiarCantidadSugerida,
} from "@/lib/whatsapp/estado";
import { generarProforma } from "@/lib/whatsapp/proforma";
import { interpretarConGemini } from "@/lib/whatsapp/gemini";
import { agregarTurno, obtenerHistorial } from "@/lib/whatsapp/memoriaConversacion";
import { mismoTelefono } from "@/lib/whatsapp/telefono";
import {
  respuestaConsultaStock,
  RESPUESTA_DESCONOCIDO,
  RESPUESTA_FUERA_DE_CATALOGO,
  RESPUESTA_TIPO_NO_SOPORTADO,
  RESPUESTA_CARRITO_VACIO,
  RESPUESTA_PRODUCTO_NO_DISPONIBLE,
  RESPUESTA_DEMASIADOS_MENSAJES,
  RESPUESTA_CANTIDAD_CANCELADA,
  RESPUESTA_PROFORMA_EN_CURSO,
  RESPUESTA_PROFORMA_SIN_PRECIO,
  RESPUESTA_PROFORMA_ERROR,
  respuestaCarrito,
  respuestaItemAgregado,
  respuestaProformaGenerada,
  respuestaSinPrecio,
  respuestaTopeCantidad,
  respuestaCantidadInvalida,
  preguntaCantidad,
} from "@/lib/whatsapp/respuestas";

/**
 * Presupuesto de la funcion en Vercel. Con el default (10s) un lote de varios
 * mensajes procesados en serie se pasaba del tope, Meta consideraba fallida la
 * entrega, reintentaba, y el cliente recibia TODAS las respuestas duplicadas.
 */
export const maxDuration = 60;

/**
 * Presupuesto de tiempo del lote completo, con margen contra maxDuration para
 * que siempre alcance a responder 200 antes de que Meta reintente. Cuando se
 * consume, los mensajes que queden se resuelven solo con reglas (sin Gemini).
 */
const PRESUPUESTO_LOTE_MS = 45_000;

/** Tiempo minimo que tiene que quedar del lote para animarse a llamar a Gemini. */
const MINIMO_PARA_GEMINI_MS = 8_000;

/** Tope de mensajes procesados por llamada al webhook: Meta puede agrupar varios. */
const MAX_MENSAJES_POR_LOTE = 20;

/** Tipos de mensaje a los que no tiene sentido responder (reacciones a mensajes previos). */
const TIPOS_SIN_RESPUESTA = new Set(["reaction"]);

/** ids de los botones de accion que se ofrecen despues de agregar un producto. */
const BOTON_SEGUIR = "seguir";
const BOTON_VER_CARRITO = "ver_carrito";
const BOTON_FINALIZAR = "finalizar";

const esDesarrollo = process.env.NODE_ENV !== "production";

interface ContactoWebhook {
  wa_id?: unknown;
  profile?: { name?: unknown };
}

interface ValueWebhook {
  messages?: unknown;
  contacts?: unknown;
}

interface CuerpoWebhook {
  entry?: { changes?: { value?: ValueWebhook }[] }[];
}

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
  const inicioLote = Date.now();

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

  let body: CuerpoWebhook;
  try {
    body = JSON.parse(rawBody) as CuerpoWebhook;
  } catch {
    console.warn("Webhook rechazado: body no es JSON valido.");
    return new NextResponse(null, { status: 400 });
  }

  // El payload completo trae telefono y nombre del cliente: solo se vuelca
  // entero en desarrollo, para no dejar datos personales en los logs de Vercel.
  if (esDesarrollo) {
    console.log("Webhook de WhatsApp recibido:", JSON.stringify(body, null, 2));
  }

  // Meta agrupa notificaciones: `entry` y `changes` son ARRAYS. Leyendo solo
  // entry[0].changes[0] los demas mensajes se perdian en silencio y sin
  // reintento posible (el webhook siempre devuelve 200).
  const pendientes: {
    mensaje: Record<string, unknown>;
    contactos: ContactoWebhook[];
  }[] = [];
  let descartados = 0;

  for (const entrada of body?.entry ?? []) {
    for (const cambio of entrada?.changes ?? []) {
      const value = cambio?.value;
      const contactos = Array.isArray(value?.contacts)
        ? (value.contacts as ContactoWebhook[])
        : [];
      const mensajes = Array.isArray(value?.messages)
        ? (value.messages as Record<string, unknown>[])
        : [];

      for (const mensaje of mensajes) {
        if (pendientes.length >= MAX_MENSAJES_POR_LOTE) {
          descartados += 1;
          continue;
        }
        pendientes.push({ mensaje, contactos });
      }
    }
  }

  if (descartados > 0) {
    console.error(
      `Webhook: ${descartados} mensaje(s) descartados por el tope de ` +
        `${MAX_MENSAJES_POR_LOTE} por llamada — esos clientes no reciben respuesta.`
    );
  }

  for (const { mensaje, contactos } of pendientes) {
    const id = typeof mensaje.id === "string" ? mensaje.id : null;

    // El id se reserva antes de procesar (para que un reintento simultaneo no
    // duplique) pero se confirma como "completado" recien si la respuesta se
    // envio bien. Si fallo, se libera para que el reintento de Meta tenga otra
    // chance real de responderle al cliente.
    if (id && !reservarMensaje(id)) {
      console.warn(`Mensaje repetido (reintento de Meta), omitido: ${id}`);
      continue;
    }

    let atendido = false;
    try {
      const presupuestoRestante = PRESUPUESTO_LOTE_MS - (Date.now() - inicioLote);
      atendido = await procesarMensaje(mensaje, contactos, presupuestoRestante);
    } catch (error) {
      console.error("Error procesando mensaje de WhatsApp:", error);
    } finally {
      if (id) {
        if (atendido) marcarMensajeCompletado(id);
        else liberarMensaje(id);
      }
    }
  }

  // Siempre 200: si Meta ve un error reintenta la entrega, y como cada
  // mensaje ya se maneja con su propio try/catch, un reintento solo
  // duplicaria envios en vez de arreglar nada.
  return NextResponse.json({ status: "ok" }, { status: 200 });
}

/**
 * Resuelve el nombre de perfil DEL REMITENTE. `contacts` es un array paralelo
 * a `messages`: usar siempre contacts[0] hacia que, en un lote con mensajes de
 * dos clientes, la cotizacion de uno se creara con el nombre del otro (y ese
 * nombre sale impreso en el PDF del ERP).
 */
function nombreDePerfil(
  contactos: ContactoWebhook[],
  remitente: string
): string | null {
  for (const contacto of contactos) {
    const waId = contacto?.wa_id;
    if (typeof waId !== "string" || !mismoTelefono(waId, remitente)) continue;
    const nombre = contacto?.profile?.name;
    return typeof nombre === "string" && nombre.trim().length > 0 ? nombre : null;
  }
  return null;
}

/**
 * Procesa un mensaje entrante. Devuelve true si el cliente quedo atendido
 * (se le respondio con exito, o no habia nada que responderle): es lo que
 * decide si el id se marca como procesado o se libera para el reintento.
 */
async function procesarMensaje(
  mensaje: Record<string, unknown>,
  contactos: ContactoWebhook[],
  presupuestoMs: number
): Promise<boolean> {
  const remitente = String(mensaje.from ?? "");
  if (!remitente) {
    console.warn("Mensaje sin remitente, omitido.");
    return true;
  }

  const nombrePerfil = nombreDePerfil(contactos, remitente);
  const tipo = mensaje.type;

  const textoCrudo =
    tipo === "text"
      ? (mensaje.text as { body?: unknown } | undefined)?.body
      : undefined;
  const texto = typeof textoCrudo === "string" ? textoCrudo : null;

  // Se consulta antes del rate limit porque las respuestas de cantidad son
  // parte del flujo de compra, no spam.
  const productoPendiente =
    texto !== null ? verProductoPendienteDeCantidad(remitente) : null;

  // Un pedido de 10 productos son ~21 mensajes entrantes: los toques de
  // boton/lista y las respuestas de cantidad se cuentan aparte, con un tope
  // propio mas alto, para no cortar una compra a mitad (antes el mensaje 21
  // podia ser justo el "Finalizar pedido" y se descartaba en silencio).
  const esFlujoDeCompra = tipo === "interactive" || productoPendiente !== null;
  const limite = evaluarLimite(remitente, esFlujoDeCompra);
  if (limite.excede) {
    console.warn(`Mensaje descartado por rate limit: ${enmascarar(remitente)}`);
    // El aviso sale una sola vez por ventana: repetirlo en cada mensaje
    // descartado seria spam del propio bot.
    if (limite.avisar) await enviarTexto(remitente, RESPUESTA_DEMASIADOS_MENSAJES);
    return true;
  }

  if (tipo === "interactive") {
    return procesarInteractivo(mensaje, remitente, nombrePerfil);
  }

  if (typeof tipo === "string" && TIPOS_SIN_RESPUESTA.has(tipo)) return true;

  if (typeof tipo !== "string") {
    console.warn(
      `Mensaje sin tipo reconocible (de ${enmascarar(remitente)}): ${JSON.stringify(tipo)}`
    );
    return enviarTexto(remitente, RESPUESTA_DESCONOCIDO);
  }

  if (tipo !== "text") {
    console.log(`Mensaje de tipo "${tipo}" (de ${enmascarar(remitente)}), no soportado.`);
    return enviarTexto(remitente, RESPUESTA_TIPO_NO_SOPORTADO);
  }

  if (texto === null || texto.trim().length === 0) {
    console.warn(`Mensaje de texto sin body valido (de ${enmascarar(remitente)}).`);
    return enviarTexto(remitente, RESPUESTA_DESCONOCIDO);
  }

  if (productoPendiente !== null) {
    return procesarRespuestaCantidad(remitente, productoPendiente, texto, presupuestoMs);
  }

  return manejarTextoNuevo(remitente, texto, presupuestoMs);
}

/** Camino normal de un mensaje de texto: reglas primero, Gemini como respaldo. */
async function manejarTextoNuevo(
  remitente: string,
  texto: string,
  presupuestoMs: number
): Promise<boolean> {
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
    return resolverConGemini(remitente, texto, presupuestoMs);
  }

  // Se registra en la memoria de conversacion aunque lo haya resuelto el
  // camino de reglas: si el proximo mensaje si requiere el respaldo de
  // Gemini, necesita saber de que se hablo antes (ej. "tienen lejia?" ->
  // "la de 4 litros").
  agregarTurno(remitente, "usuario", texto);

  const productos = await buscarProductos(resultado.productoTexto!);
  console.log(
    `Productos encontrados para "${resultado.productoTexto}": ${productos.length}`
  );
  if (esDesarrollo) console.log(productos);

  if (productos.length === 0) {
    const respuesta = respuestaConsultaStock(productos);
    agregarTurno(remitente, "bot", respuesta);
    return enviarTexto(remitente, respuesta);
  }

  return responderConProductos(
    remitente,
    productos,
    resultado.intent === "armar_pedido",
    resultado.cantidad
  );
}

/**
 * Responde una busqueda con productos. Si el cliente ya dijo la cantidad y hay
 * una sola coincidencia, se agrega directo al carrito en vez de preguntarle
 * algo que ya contesto ("necesito 20 lejias de 4 litros"). Con varias
 * coincidencias la cantidad se guarda para recordarsela al elegir la fila.
 */
async function responderConProductos(
  remitente: string,
  productos: ProductoEncontrado[],
  esPedido: boolean,
  cantidad: number | null
): Promise<boolean> {
  guardarUltimaBusqueda(remitente, productos);

  if (esPedido && cantidad !== null && productos.length === 1) {
    limpiarCantidadSugerida(remitente);
    agregarTurno(remitente, "bot", `Agregué ${productos[0].nombre} x${cantidad}`);
    return agregarProductoAlCarrito(remitente, productos[0].id, cantidad);
  }

  if (cantidad !== null) guardarCantidadSugerida(remitente, cantidad);
  else limpiarCantidadSugerida(remitente);

  agregarTurno(remitente, "bot", `Mostré: ${productos.map((p) => p.nombre).join(", ")}`);
  return enviarListaProductos(remitente, productos);
}

/**
 * Respaldo cuando las reglas de intent.ts no entendieron el mensaje: se
 * intenta con Gemini (interpretarConGemini ya maneja circuit breaker,
 * timeout y cualquier falla — nunca lanza). Si tampoco resuelve nada, se
 * cae en la misma RESPUESTA_DESCONOCIDO de siempre.
 */
async function resolverConGemini(
  remitente: string,
  texto: string,
  presupuestoMs: number
): Promise<boolean> {
  // Un numero suelto sin pregunta de cantidad pendiente no tiene nada que
  // interpretar: no se gasta cuota de Gemini (son 20 llamadas por dia en el
  // plan gratis) ni tiempo del lote en eso.
  if (/^\d+$/.test(texto.trim())) {
    agregarTurno(remitente, "bot", RESPUESTA_DESCONOCIDO);
    return enviarTexto(remitente, RESPUESTA_DESCONOCIDO);
  }

  // Presupuesto del lote agotado: se saltea Gemini y se responde con lo que
  // dan las reglas. Mejor una respuesta pobre que un timeout de la funcion
  // que haga reintentar a Meta y duplique todo.
  if (presupuestoMs < MINIMO_PARA_GEMINI_MS) {
    console.warn(
      `Presupuesto del lote casi agotado (${presupuestoMs}ms): se omite Gemini.`
    );
    agregarTurno(remitente, "usuario", texto);
    agregarTurno(remitente, "bot", RESPUESTA_DESCONOCIDO);
    return enviarTexto(remitente, RESPUESTA_DESCONOCIDO);
  }

  agregarTurno(remitente, "usuario", texto);

  const interpretacion = await interpretarConGemini(texto, obtenerHistorial(remitente));

  if (interpretacion?.intent === "fuera_de_catalogo") {
    agregarTurno(remitente, "bot", RESPUESTA_FUERA_DE_CATALOGO);
    return enviarTexto(remitente, RESPUESTA_FUERA_DE_CATALOGO);
  }

  if (!interpretacion || interpretacion.intent === "desconocido" || interpretacion.items.length === 0) {
    agregarTurno(remitente, "bot", RESPUESTA_DESCONOCIDO);
    return enviarTexto(remitente, RESPUESTA_DESCONOCIDO);
  }

  const productos = await buscarProductosPorTerminos(
    interpretacion.items.map((item) => item.textoBusqueda)
  );
  console.log(
    `[Gemini] Productos encontrados para "${texto}": ${productos.length}`
  );
  if (esDesarrollo) console.log(productos);

  if (productos.length === 0) {
    const respuesta = respuestaConsultaStock(productos);
    agregarTurno(remitente, "bot", respuesta);
    return enviarTexto(remitente, respuesta);
  }

  // Solo se aprovecha la cantidad si Gemini interpreto UN producto: con varios
  // items no se puede saber a cual corresponde cada numero.
  const cantidad =
    interpretacion.items.length === 1 ? interpretacion.items[0].cantidad : null;

  return responderConProductos(
    remitente,
    productos,
    interpretacion.intent === "armar_pedido",
    cantidad
  );
}

/** Maximo de filas por mensaje de lista interactiva: limite duro de la API de WhatsApp. */
const MAX_FILAS_POR_LISTA = 10;

async function enviarListaProductos(
  destinatario: string,
  productos: ProductoEncontrado[],
  introduccion = "Esto encontré"
): Promise<boolean> {
  const lotes: ProductoEncontrado[][] = [];
  for (let i = 0; i < productos.length; i += MAX_FILAS_POR_LISTA) {
    lotes.push(productos.slice(i, i + MAX_FILAS_POR_LISTA));
  }

  // Se acumulan los productos de los lotes que FALLARON, no un booleano: con
  // un booleano, si fallaba el ultimo lote se reenviaba la lista completa en
  // texto y el cliente veia todo duplicado.
  const productosFallidos: ProductoEncontrado[] = [];

  for (let i = 0; i < lotes.length; i++) {
    const cuerpo =
      lotes.length > 1
        ? `${introduccion} (${i + 1}/${lotes.length}). Tocá un producto para agregarlo a tu pedido:`
        : `${introduccion}. Tocá un producto para agregarlo a tu pedido:`;

    const filas: FilaLista[] = lotes[i].map((p) => ({
      id: `add_${p.id}`,
      titulo: p.nombre,
      descripcion:
        p.precio_venta !== null ? `S/ ${p.precio_venta.toFixed(2)}` : "Consultar precio",
    }));

    const enviado = await enviarListaInteractiva(destinatario, cuerpo, "Ver productos", [
      { titulo: "Resultados", filas },
    ]);

    if (!enviado) productosFallidos.push(...lotes[i]);
  }

  if (productosFallidos.length === 0) return lotes.length > 0;

  // Fallback a texto plano solo de lo que no se pudo enviar como lista.
  return enviarTexto(destinatario, respuestaConsultaStock(productosFallidos));
}

async function enviarBotonesAccion(destinatario: string): Promise<boolean> {
  return enviarBotones(destinatario, "Elegí una opción:", [
    { id: BOTON_SEGUIR, titulo: "Seguir comprando" },
    { id: BOTON_VER_CARRITO, titulo: "Ver carrito" },
    { id: BOTON_FINALIZAR, titulo: "Finalizar pedido" },
  ]);
}

/**
 * Ultimo recurso para cualquier rama que no sepa que hacer con el payload:
 * antes varias de estas ramas hacian `return` sin enviar nada y el cliente
 * quedaba sin respuesta. Se loggea solo el bloque `interactive` (no el mensaje
 * completo) para no dejar el telefono del cliente en los logs de Vercel.
 */
async function responderNoReconocido(
  remitente: string,
  contexto: string,
  payload: unknown
): Promise<boolean> {
  console.warn(
    `Interaccion no reconocida (${contexto}) de ${enmascarar(remitente)}:`,
    JSON.stringify(payload)
  );
  return enviarTexto(remitente, RESPUESTA_DESCONOCIDO);
}

async function procesarInteractivo(
  mensaje: Record<string, unknown>,
  remitente: string,
  nombrePerfil: string | null
): Promise<boolean> {
  const interactive = mensaje.interactive as Record<string, unknown> | undefined;

  if (interactive?.type === "list_reply") {
    const listReply = interactive.list_reply as { id?: unknown } | undefined;
    const id = listReply?.id;
    if (typeof id === "string" && id.startsWith("add_")) {
      const productoId = Number(id.slice("add_".length));
      if (Number.isFinite(productoId)) {
        return pedirCantidad(remitente, productoId);
      }
    }
    return responderNoReconocido(remitente, "list_reply", interactive);
  }

  if (interactive?.type === "button_reply") {
    const buttonReply = interactive.button_reply as { id?: unknown } | undefined;
    const id = buttonReply?.id;

    if (id === BOTON_SEGUIR) {
      return enviarTexto(remitente, "Decime qué otro producto buscás.");
    }

    if (id === BOTON_VER_CARRITO) {
      const items = obtenerCarrito(remitente);
      const enviado = await enviarTexto(remitente, respuestaCarrito(items));
      if (items.length > 0) await enviarBotonesAccion(remitente);
      return enviado;
    }

    if (id === BOTON_FINALIZAR) {
      return finalizarPedido(remitente, nombrePerfil);
    }

    return responderNoReconocido(remitente, "button_reply", interactive);
  }

  return responderNoReconocido(remitente, "interactive", interactive ?? null);
}

async function finalizarPedido(
  remitente: string,
  nombrePerfil: string | null
): Promise<boolean> {
  const items = obtenerCarrito(remitente);
  if (items.length === 0) {
    return enviarTexto(remitente, RESPUESTA_CARRITO_VACIO);
  }

  // Dos toques de "Finalizar pedido" son dos mensajes con id distinto, asi que
  // el dedupe no los frena: sin este candado se creaban dos cotizaciones
  // identicas en el ERP.
  if (!marcarGenerandoProforma(remitente)) {
    console.warn(`Proforma ya en curso para ${enmascarar(remitente)}, se ignora el toque.`);
    return enviarTexto(remitente, RESPUESTA_PROFORMA_EN_CURSO);
  }

  try {
    const resultado = await generarProforma(remitente, nombrePerfil, items);

    if (resultado.ok) {
      vaciarCarrito(remitente);
      limpiarCantidadSugerida(remitente);
      return enviarTexto(remitente, respuestaProformaGenerada(resultado.proforma));
    }

    if (resultado.motivo === "sin_precio") {
      // El carrito NO se vacia: un vendedor puede retomarlo con el cliente.
      return enviarTexto(remitente, RESPUESTA_PROFORMA_SIN_PRECIO);
    }

    return enviarTexto(remitente, RESPUESTA_PROFORMA_ERROR);
  } finally {
    liberarGenerandoProforma(remitente);
  }
}

/** Tras tocar un producto en la lista, se pregunta la cantidad por texto libre — sin mostrar ni limitar por stock. */
async function pedirCantidad(remitente: string, productoId: number): Promise<boolean> {
  const producto = await obtenerProductoPorId(productoId);
  if (!producto) {
    return enviarTexto(remitente, RESPUESTA_PRODUCTO_NO_DISPONIBLE);
  }

  // Sin precio cargado no se pregunta la cantidad ni se agrega al carrito: la
  // cotizacion del ERP saldria en S/ 0.00.
  if (producto.precio_venta === null) {
    console.warn(`Producto ${producto.id} sin precio_venta: no entra al carrito.`);
    return enviarTexto(remitente, respuestaSinPrecio(producto.nombre));
  }

  const sugerida = verCantidadSugerida(remitente);
  pedirCantidadPara(remitente, productoId);
  return enviarTexto(remitente, preguntaCantidad(producto.nombre, sugerida));
}

/** Palabras sueltas con las que el cliente sale de la pregunta de cantidad. */
const PALABRAS_ESCAPE = new Set([
  "cancelar",
  "cancela",
  "cancelalo",
  "no",
  "nada",
  "ninguna",
  "ninguno",
  "mejor",
  "olvidalo",
  "olvidate",
  "dejalo",
  "salir",
  "stop",
]);

/** Frases de escape (mas de una palabra). */
const FRASES_ESCAPE = ["otra cosa", "ya no", "no quiero", "no gracias"];

/** Reintentos fallidos antes de soltar el pendiente igual (nunca dejar al cliente atrapado). */
const MAX_INTENTOS_CANTIDAD = 2;

function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Interpreta la respuesta a "¿cuántas unidades?".
 *
 * Antes este estado secuestraba TODO mensaje de texto: si no era exactamente
 * `/^\d+$/` se repetia la misma respuesta y se mantenia el pendiente, asi que
 * el cliente quedaba atrapado sin salida. Ahora: acepta palabras de escape,
 * saca el numero de frases como "3 cajas" o "10.", y si el mensaje se entiende
 * como algo nuevo abandona la pregunta y lo trata como tal.
 */
async function procesarRespuestaCantidad(
  remitente: string,
  productoId: number,
  texto: string,
  presupuestoMs: number
): Promise<boolean> {
  const normalizado = normalizarTexto(texto);
  const palabras = normalizado.split(" ").filter(Boolean);
  // /\d+/ en vez de /^\d+$/: los clientes escriben "3 cajas", "unas 5",
  // "5 porfa", "10.". Si hay un numero, gana el numero (asi "no, 3" tambien
  // se entiende como cantidad 3).
  const match = texto.match(/\d+/);

  if (match) {
    const cantidad = Number.parseInt(match[0], 10);

    if (Number.isSafeInteger(cantidad) && cantidad > 0 && cantidad <= CANTIDAD_MAXIMA) {
      limpiarPendienteDeCantidad(remitente);
      limpiarCantidadSugerida(remitente);
      return agregarProductoAlCarrito(remitente, productoId, cantidad);
    }

    if (registrarIntentoFallidoDeCantidad(remitente) > MAX_INTENTOS_CANTIDAD) {
      limpiarPendienteDeCantidad(remitente);
      limpiarCantidadSugerida(remitente);
      return enviarTexto(remitente, RESPUESTA_CANTIDAD_CANCELADA);
    }

    return enviarTexto(remitente, respuestaCantidadInvalida(CANTIDAD_MAXIMA));
  }

  // Sin ningun digito: si el mensaje se entiende como algo nuevo ("mejor
  // necesito papel"), se abandona la pregunta de cantidad en vez de repetir lo
  // mismo en loop. Se evalua ANTES del escape para que un "cancelar, mejor
  // necesito lejia" haga la busqueda nueva en vez de solo cancelar.
  if (detectarIntencion(texto).intent !== "desconocido") {
    limpiarPendienteDeCantidad(remitente);
    return manejarTextoNuevo(remitente, texto, presupuestoMs);
  }

  // Palabras de escape: el cliente quiere salir de la pregunta ("cancelar",
  // "no", "nada", "mejor otra cosa"). Antes no habia ninguna salida.
  const quiereSalir =
    palabras.some((palabra) => PALABRAS_ESCAPE.has(palabra)) ||
    FRASES_ESCAPE.some((frase) => normalizado.includes(frase));

  if (quiereSalir) {
    limpiarPendienteDeCantidad(remitente);
    limpiarCantidadSugerida(remitente);
    return enviarTexto(remitente, RESPUESTA_CANTIDAD_CANCELADA);
  }

  // Tras un par de intentos se suelta el pendiente igual y el mensaje se trata
  // como nuevo: el respaldo de Gemini puede entender lo que las reglas no, y
  // el cliente nunca queda encerrado.
  if (registrarIntentoFallidoDeCantidad(remitente) > MAX_INTENTOS_CANTIDAD) {
    limpiarPendienteDeCantidad(remitente);
    return manejarTextoNuevo(remitente, texto, presupuestoMs);
  }

  return enviarTexto(
    remitente,
    'Escribí solo el número de unidades, por ejemplo: 3. Si preferís, escribí "cancelar".'
  );
}

async function agregarProductoAlCarrito(
  remitente: string,
  productoId: number,
  cantidad: number
): Promise<boolean> {
  const producto = await obtenerProductoPorId(productoId);
  if (!producto) {
    return enviarTexto(remitente, RESPUESTA_PRODUCTO_NO_DISPONIBLE);
  }

  const resultado = agregarItem(remitente, producto, cantidad);

  if (!resultado.ok) {
    if (resultado.motivo === "sin_precio") {
      console.warn(`Producto ${producto.id} sin precio_venta: no entra al carrito.`);
      return enviarTexto(remitente, respuestaSinPrecio(producto.nombre));
    }
    return enviarTexto(
      remitente,
      respuestaTopeCantidad(producto.nombre, resultado.acumulado, resultado.maximo)
    );
  }

  const avisoAgregado = await enviarTexto(remitente, respuestaItemAgregado(resultado.item));

  // WhatsApp solo permite tocar UNA fila por mensaje de lista: se reenvia el
  // mismo listado de la ultima busqueda para que el cliente pueda seguir
  // agregando (ej. varias bolsas distintas) sin tener que reescribir la
  // busqueda de nuevo.
  const ultimaBusqueda = obtenerUltimaBusqueda(remitente);
  if (ultimaBusqueda && ultimaBusqueda.length > 0) {
    await enviarListaProductos(remitente, ultimaBusqueda, "¿Algo más de esta lista?");
  }

  await enviarBotonesAccion(remitente);
  return avisoAgregado;
}
