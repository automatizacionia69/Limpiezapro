# RESUMEN — Estado del proyecto

> Documento de continuidad. Si estás retomando el proyecto en otra máquina
> (o en una sesión nueva de Claude Code), **lee esto primero**.
>
> Última actualización: 2026-07-27

---

## 1. Qué es esto

Implementación técnica de **Distribuidora LimpiezaPro** (ver `CLAUDE.md` para el
contexto de negocio completo): ERP de inventarios + chatbot de WhatsApp sobre el
mismo inventario.

**Stack montado:** Next.js 16.2.12 (App Router) · TypeScript · Tailwind ·
Supabase (PostgreSQL) · WhatsApp Cloud API.

---

## 2. Avance real: ~25% del MVP

| # | Pieza del MVP | Estado |
|---|---|---|
| 1 | Login Supabase Auth (roles) | ⬜ No iniciado |
| 2 | CRUD de productos (UI) | ⬜ No iniciado |
| 3 | Registrar movimientos (UI) | ⬜ No iniciado |
| 4 | Dashboard stock consolidado | ⬜ No iniciado |
| 5 | Alertas de stock bajo | ⬜ No iniciado (la vista ya existe en BD) |
| 6 | Webhook WhatsApp | ✅ **Listo y probado** |
| 7 | Chatbot: consulta precio/stock | 🔶 **A medias** (ver §6) |
| 8 | Chatbot: armar pedido | ⬜ No iniciado (faltan tablas) |

**No existe UI todavía.** Solo el backend del chatbot. `app/page.tsx` sigue
siendo la portada por defecto de Next.js.

---

## 3. Puesta en marcha en una máquina nueva

```bash
git clone <url-del-repo>
cd proyecto
npm install
```

Luego crear el archivo `.env.local` (**no viene en el repo, es intencional**)
copiando `.env.local.example` y llenando los valores:

```
NEXT_PUBLIC_SUPABASE_URL=<Supabase → Project Settings → API>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<Supabase → Project Settings → API>
SUPABASE_SERVICE_ROLE_KEY=<misma pantalla — NUNCA exponer al navegador>
WHATSAPP_VERIFY_TOKEN=<inventado por nosotros, debe coincidir con Meta>
WHATSAPP_ACCESS_TOKEN=<Meta → WhatsApp → API Setup>
WHATSAPP_PHONE_NUMBER_ID=<Meta → WhatsApp → API Setup>
WHATSAPP_APP_SECRET=<Meta → Configuración → Básica → Clave secreta>
```

Arrancar con `npm run dev` → http://localhost:3000

**Los secretos nunca van al repo.** En producción se cargan en el panel de
variables de entorno de Vercel.

---

## 4. Estado de la base de datos (Supabase)

Proyecto: el de la cuenta de Supabase de ALU (ver panel de Supabase).

| Objeto | Estado |
|---|---|
| `zonas` | 4 filas: Sala Comedor (1), Cochera (2), Cuarto 1 (3), Cocina (4) |
| `productos` | **15 SKUs de PRUEBA** — no son los reales |
| `movimientos` | Vacía |
| `usuarios_perfil` | Vacía |
| `productos_stock_bajo` | Vista (⚠️ ver §7) |

Columnas reales de `productos`:
`id · nombre · codigo · zona_id · unidad · cantidad · punto_reorden ·
categoria · observacion · creado_en · actualizado_en`

> ⚠️ **No existe columna `precio`.** El chatbot no puede responder precios
> hasta que se agregue. La consulta de stock sí funciona.

---

## 5. Código escrito

```
app/api/whatsapp/webhook/route.ts   Webhook: GET verificación + POST mensajes
lib/whatsapp/firma.ts               Valida X-Hub-Signature-256 (HMAC de Meta)
lib/whatsapp/intent.ts              Detección de intención por reglas de texto
lib/whatsapp/productos.ts           Búsqueda de productos en Supabase (ilike)
lib/whatsapp/rateLimit.ts           Límite 20 msg/min por número
lib/supabase/admin.ts               Cliente service_role — SOLO server-side
lib/supabase/server.ts              Cliente anon (creado, aún sin uso)
sql/01_cerrar_fuga_vistas.sql       ⚠️ PENDIENTE DE EJECUTAR (ver §7)
```

### Cómo funciona el flujo actual

1. Llega POST a `/api/whatsapp/webhook`
2. Se valida la firma HMAC → si falla, **401**
3. Rate limit por número → si excede, se descarta
4. `detectarIntencion(texto)` → `consultar_stock` | `armar_pedido` | `desconocido`
5. Si hay producto, `buscarProductos()` consulta Supabase
6. **Se loggea el resultado. Todavía NO se responde por WhatsApp.**

### Probar el webhook localmente

```powershell
$secret = "<tu WHATSAPP_APP_SECRET>"
$json = '{"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"519","phone_number_id":"111"},"contacts":[{"profile":{"name":"T"},"wa_id":"519"}],"messages":[{"from":"51987654321","id":"wamid.X","timestamp":"1","type":"text","text":{"body":"tienen papel higienico"}}]}}]}]}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [System.Text.Encoding]::UTF8.GetBytes($secret)
$sig = "sha256=" + (($hmac.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join "")
Invoke-WebRequest -Uri "http://localhost:3000/api/whatsapp/webhook" -Method POST -Body $bytes -Headers @{ "X-Hub-Signature-256" = $sig } -ContentType "application/json" -UseBasicParsing
```

Resultados verificados: `"tienen papel higienico"` → 4 productos ·
`"cuanto cuesta la lejia"` → Lejía 1L y 4L · `"que tal como estan"` → `desconocido`.

---

## 6. Lo que falta para cerrar el chatbot (pieza 7)

1. **Responder por WhatsApp.** Hoy solo se hace `console.log`. Falta llamar a la
   Graph API de Meta (`POST /{phone_number_id}/messages`) con el
   `WHATSAPP_ACCESS_TOKEN`.
2. **Precios.** Requiere agregar la columna (ver §7).
3. **Conectar Meta de verdad.** Requiere URL pública (Vercel o ngrok) +
   registrar el webhook en el panel de Meta.

Para la pieza 8 faltan las tablas `pedidos` / `pedido_items` — con la regla de
`CLAUDE.md`: un pedido **no descuenta stock**; el movimiento de salida se genera
recién cuando pasa a `despachado`.

---

## 7. ⚠️ PENDIENTES QUE REQUIEREN ACCIÓN MANUAL

### 7.1 Cerrar fuga de datos (prioritario)

La vista `productos_stock_bajo` **es legible por usuarios anónimos** y expone
nombre, código, stock y zona de los productos que se están agotando. Las tablas
sí están protegidas por RLS; la vista las saltea porque en Postgres las vistas
corren con permisos de su creador.

**Acción:** pegar `sql/01_cerrar_fuga_vistas.sql` completo en
Supabase → SQL Editor → Run. Es idempotente.

> El SQL Editor es una **página web** (supabase.com), no un programa instalado:
> se abre desde cualquier navegador con iniciar sesión.

La **Parte 4** de ese archivo lista las políticas RLS. Durante la auditoría no
se pudieron leer (sin acceso SQL solo se probó el comportamiento de `anon`), así
que **las políticas de `admin` / `almacen` / `ventas` siguen sin verificar.**
Guardar ese resultado para revisarlo.

### 7.2 Cargar el inventario real

Los 15 SKUs actuales son inventados. Falta importar los ~140 reales desde
`Inventario_Distribuidora_LimpiezaPro.xlsx` (está en la otra laptop, no en el repo).

### 7.3 Agregar columna de precio

```sql
alter table public.productos add column precio numeric(10,2);
```
Después incluir `precio` en el `select` de `lib/whatsapp/productos.ts`.

### 7.4 Al conectar Meta

- Cambiar `WHATSAPP_VERIFY_TOKEN` por un valor largo y aleatorio: el que está
  hoy en `.env.local` es un valor de prueba.
- Poner el `WHATSAPP_APP_SECRET` real (el actual también es de prueba).

> Ningún valor de credencial se documenta en este archivo. Los nombres de las
> variables están en `.env.local.example`; los valores se sacan de los paneles
> de Supabase y Meta, o del gestor de variables de Vercel.

---

## 8. Seguridad — auditoría del 2026-07-27

### Corregido y verificado

| Hallazgo | Severidad | Corrección |
|---|---|---|
| Webhook aceptaba POST de cualquiera | Crítico | Validación HMAC `X-Hub-Signature-256` |
| Inyección de filtro PostgREST | Alto | Whitelist en `sanitizarTermino()` |
| Teléfonos y nombres en logs | Medio | Enmascarado `519****4321`; volcado solo en dev |
| Sin rate limiting | Medio | 20 msg/min por número |
| Cantidades sin validar | Bajo | Rango 1–10 000 |

La inyección **era explotable**: el mensaje `tienen %%%` devolvía el catálogo
completo (`%` es comodín LIKE) ejecutándose con `service_role`, que ignora RLS.
Tras el fix devuelve 0.

### Verificado sin hallazgos

- Ningún secreto hardcodeado en el código.
- El valor de `service_role` no aparece en ningún bundle compilado.
- No hay componentes `"use client"`, así que nada del navegador toca `admin.ts`.
- RLS de tablas confirmado empíricamente: `anon` no pudo leer, modificar ni
  borrar filas reales.

### Pendiente / aceptado

- **Fuga de la vista** → §7.1
- **Políticas por rol sin verificar** → §7.1
- **`npm audit`: 12 high, 0 críticas.** Todas en dependencias de desarrollo o
  transitivas de Next.js; ninguna explotable en producción con el código actual.
  🚫 **No correr `npm audit fix --force`**: propone bajar Next.js de 16.2.12 a
  9.3.3 y rompería el proyecto.
- **El rate limiter es en memoria.** En Vercel cada instancia serverless tiene
  el suyo, así que frena spam básico pero no a un atacante decidido. Para
  producción real hace falta Upstash Redis o Vercel KV.

---

## 9. Siguiente paso sugerido

1. Correr `sql/01_cerrar_fuga_vistas.sql` (§7.1) — es el único riesgo abierto.
2. Deploy a Vercel + registrar el webhook en Meta.
3. Responder por WhatsApp (§6.1) para cerrar la pieza 7.
4. Recién ahí, empezar la UI del ERP (piezas 1–5), que es el grueso del MVP.
