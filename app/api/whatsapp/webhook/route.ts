import { NextRequest, NextResponse } from "next/server";
import { detectarIntencion } from "@/lib/whatsapp/intent";
import { buscarProductos } from "@/lib/whatsapp/productos";
import { firmaEsValida } from "@/lib/whatsapp/firma";
import { excedeLimite } from "@/lib/whatsapp/rateLimit";

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

  const mensajes = body?.entry?.[0]?.changes?.[0]?.value?.messages ?? [];

  for (const mensaje of mensajes) {
    if (mensaje.type === "text") {
      const remitente = String(mensaje.from ?? "");

      if (excedeLimite(remitente)) {
        console.warn(
          `Mensaje descartado por rate limit: ${enmascarar(remitente)}`
        );
        continue;
      }

      const texto = mensaje.text.body;
      const resultado = detectarIntencion(texto);
      console.log(
        `Intencion detectada (de ${enmascarar(remitente)}):`,
        resultado.intent
      );

      const requiereBusqueda =
        (resultado.intent === "consultar_stock" ||
          resultado.intent === "armar_pedido") &&
        resultado.productoTexto;

      if (requiereBusqueda) {
        const productos = await buscarProductos(resultado.productoTexto!);
        console.log(
          `Productos encontrados para "${resultado.productoTexto}": ${productos.length}`
        );
        if (esDesarrollo) console.log(productos);
      }
    }
  }

  return NextResponse.json({ status: "ok" }, { status: 200 });
}
