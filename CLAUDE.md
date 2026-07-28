# CLAUDE.md — Distribuidora LimpiezaPro (ERP de Inventarios + Chatbot WhatsApp)

## Quiénes somos
Consultora de automatización con IA para pequeños y medianos negocios en la región de Piura, Perú. Equipo de dos personas: ALU y Alvaro Santti Querevalu (contacto: automatizacionia69@gmail.com).

Trabajamos bajo una metodología propia, "5 Bloques", que aplicamos a cada cliente:
1. **AS-IS** — diagnóstico del proceso actual
2. **TO-BE** — rediseño del proceso con intervenciones de automatización
3. **Arquitectura técnica**
4. **Propuesta comercial**
5. **Roadmap de implementación**

Los entregables de negocio (diagnósticos, propuestas) se documentan en Notion. Este repositorio es la implementación técnica (Bloque 3 en adelante) de un caso de estudio de portafolio.

Caso anterior ya cerrado: sistema de gestión de inventario para un taller mecánico. Este es el segundo caso.

## El cliente (caso de estudio simulado)
**Distribuidora LimpiezaPro** — mayorista de productos de limpieza e higiene (papel higiénico, papel toalla, servilletas, lejía, detergentes, guantes, bolsas, dispensadores) en Piura. Abastece a minimarkets, restaurantes, hoteles y clínicas.

Estructura: ~7 personas — 2 en Almacén, 3 en Ventas/Reparto, 1 en Caja/Facturación, 1 dueño-administrador.

El inventario real (transcrito de cuadernos físicos del almacén) organiza el stock en 4 zonas heredadas de una antigua casa: Sala Comedor, Cochera, Cuarto 1, Cocina. ~140 SKUs. Archivo base: `data/Inventario_Distribuidora_LimpiezaPro.xlsx`.

## Problemática (diagnóstico AS-IS)
1. Inventario 100% manual en cuadernos por zona, sin vista consolidada.
2. Códigos de producto inconsistentes; productos similares se confunden en el despacho.
3. Quiebres de stock que se detectan recién al momento del despacho.
4. Pedidos por WhatsApp/llamada sin registro central — vendedores prometen stock que ya no existe.
5. Compras de reposición hechas "a ojo", sin punto de reorden ni histórico de rotación.
6. Facturación en talonario físico, sin trazabilidad cruzada con salidas de almacén.
7. Sin control FIFO — riesgo de vencimiento de stock antiguo mientras se despacha el nuevo.

## Qué estamos construyendo
Dos módulos conectados al mismo inventario:

**1. ERP de inventarios (web app)**
- CRUD de productos: crear, editar, eliminar, ajustar stock.
- Organización por zona/ubicación (reemplaza los cuadernos físicos).
- Alertas de stock bajo / punto de reorden.
- Historial de movimientos (entradas, salidas, ajustes) con trazabilidad de quién hizo qué.
- Vista consolidada de stock total por producto y por zona.

**2. Chatbot de WhatsApp (clientes y vendedores)**
- Integración: **WhatsApp Cloud API (Meta oficial)**. En fase de desarrollo se usa el modo de prueba gratuito (hasta 5 números verificados manualmente), sin necesidad de verificación de negocio todavía.
- Webhook en `/api/whatsapp/webhook` (GET para verificación del webhook, POST para recibir mensajes entrantes).
- Conectado al inventario en tiempo real vía Supabase.
- v1: permite (a) **consultar precio y stock** de un producto, (b) **armar un pedido**.
- Detección de intención en v1 por reglas simples de texto (no LLM todavía — se evalúa agregarlo más adelante).
- Un pedido **no descuenta stock automáticamente**: el `movimiento` de salida se genera recién cuando el pedido pasa a estado `despachado`.
- Debe evitar que se prometa/venda algo que ya no hay físicamente.

## Prioridades de diseño
- Simplicidad de uso para personal no técnico (los usuarios reales serían almaceneros y vendedores de un negocio pequeño, no desarrolladores).
- Este es un proyecto de portafolio: el código y la demo deben verse profesionales, porque se mostrarán a futuros clientes reales.

## Stack técnico (decidido)
- **Frontend/Backend**: Next.js (App Router), TypeScript, Tailwind CSS.
- **Base de datos + Auth + API**: Supabase (PostgreSQL). El esquema base está en `schema.sql` — correrlo en el SQL Editor de Supabase antes de empezar a codear.
- **WhatsApp**: WhatsApp Cloud API (Meta), sin intermediarios (Twilio, etc.).
- **Deploy**: Vercel (free tier), para poder mandar el link de demo a clientes fácilmente.

## Modelo de datos (`schema.sql`)
- `zonas` — las 4 zonas del almacén (editable a futuro si se reorganiza la logística).
- `productos` — SKU maestro. **`cantidad` no se edita a mano nunca**: se recalcula automáticamente vía trigger cada vez que se inserta un registro en `movimientos`.
- `movimientos` — ledger de entradas/salidas/ajustes. Es la fuente de verdad para trazabilidad. Incluye `referencia`, para enlazar movimientos con pedidos que vengan del chatbot.
- `usuarios_perfil` — extiende `auth.users` de Supabase con un rol: `admin`, `almacen`, `ventas`.
- Vista `productos_stock_bajo` — productos con `cantidad <= punto_reorden`, para el módulo de alertas.
- `pedidos` / `pedido_items` — **pendiente de agregar** (tablas para el chatbot: cabecera del pedido con estado `pendiente | confirmado | despachado | cancelado`, y sus líneas de producto/cantidad/precio). Se define cuando se retome esa parte.

## Funcionalidad del MVP (en orden de prioridad)
1. Login con Supabase Auth (roles: admin, almacén, ventas).
2. CRUD de productos (crear, editar, eliminar, ver por zona).
3. Registrar movimientos (entrada/salida/ajuste) desde la UI — nunca editar `cantidad` directamente.
4. Dashboard con stock consolidado por producto y por zona.
5. Alertas de stock bajo (usando la vista `productos_stock_bajo`).
6. Webhook de WhatsApp Cloud API: verificación + recepción de mensajes.
7. Chatbot: consulta de precio/stock por WhatsApp.
8. Chatbot: armar y registrar un pedido (tablas `pedidos`/`pedido_items` pendientes).

## Reglas para trabajar en este repo
- Las credenciales (Access Token de WhatsApp, keys de Supabase) van siempre en `.env.local`, nunca hardcodeadas ni escritas en este archivo.
- Ir por partes: no pedir features completos de una sola vez. Construir y probar una pieza a la vez (ej. primero el webhook solo, luego la lógica de intención, luego la conexión a Supabase).
