# RESUMEN — Estado del proyecto

> Documento de continuidad. Si estás retomando el proyecto en otra máquina
> (o en una sesión nueva de Claude Code), **lee esto primero**.
>
> Última actualización: 2026-07-29 (noche — sesión cortada a mitad de
> continuar en la otra laptop, ver §6.0.5 para retomar mañana)

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
| 7 | Chatbot: consulta precio/stock | ✅ **Listo y probado end-to-end** (2026-07-29, ver §6) |
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
app/api/whatsapp/webhook/route.ts   Webhook: GET verificación + POST mensajes, arma y envía respuesta
lib/whatsapp/firma.ts               Valida X-Hub-Signature-256 (HMAC de Meta)
lib/whatsapp/intent.ts              Detección de intención por reglas de texto
lib/whatsapp/productos.ts           Búsqueda en Supabase (ilike) con joins a unidad/categoría + precio_venta
lib/whatsapp/enviar.ts              enviarTexto(): POST a la Graph API de Meta
lib/whatsapp/respuestas.ts          Formatea resultados de productos en texto para WhatsApp
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

### Bug corregido (2026-07-28): "cuanto esta la lejia" → desconocido

Validado end-to-end con un mensaje real de WhatsApp (POST 200, firma
verificada). `"cuanto esta la lejia"` (sin tildes) se clasificaba como
`desconocido` en vez de `consultar_stock`.

**No era problema de tildes** — `normalizar()` en `lib/whatsapp/intent.ts` ya
las quitaba bien. La causa real: `PALABRAS_CONSULTA` no tenía ninguna frase
que cubriera "cuanto **está**" (solo "cuanto cuesta", "cuanto vale", "cuanto
tienen"). Se agregaron `"cuanto esta"` y `"cuanto sale"` (variante común en
Piura). Probado con `tsx` contra "cuanto esta la lejia", "cuánto está la
lejía", "cuanto sale el papel higienico" y los casos previos — todos
clasifican correctamente y `extraerProducto` limpia bien la frase.

---

## 6.0 Botones interactivos + carrito + proforma real en el ERP (2026-07-29)

Se agregó un flujo completo de compra por WhatsApp usando mensajes
interactivos de la Graph API (no solo texto):

- `lib/whatsapp/enviar.ts` — `enviarListaInteractiva()` (mensaje tipo
  "list", hasta 10 filas) y `enviarBotones()` (hasta 3 botones de
  respuesta rápida). Recortan textos a los límites que exige WhatsApp
  (título de fila 24, descripción 72, texto de botón 20).
- `lib/whatsapp/carrito.ts` — carrito en memoria por número de teléfono
  (ventana de 30 min de inactividad). Misma limitación que
  `rateLimit.ts`/`dedupe.ts`: vive en memoria del proceso, no sobrevive
  reinicios ni es compartido entre instancias de Vercel.
- `lib/whatsapp/proforma.ts` — `generarProforma()`: busca o crea el
  `cliente` por teléfono y crea una **cotización real en las tablas del
  ERP** (`cotizaciones` + `detalle_cotizacion`), con el mismo cálculo de
  IGV (18%) que usa `src/lib/cotizaciones.ts` del repo `limpiezaproERP`.
  El número (`COT-00001...`) lo genera la base de datos. Son dos inserts
  secuenciales sin transacción (mismo patrón que el resto del proyecto,
  sin RPC todavía) — si el segundo falla, la cabecera queda huérfana y se
  loggea para revisión manual.
- `app/api/whatsapp/webhook/route.ts` — cuando una búsqueda de texto
  encuentra productos, en vez de responder solo texto manda una **lista
  interactiva** (`add_<id>` por fila). Al tocar una fila se agrega al
  carrito y se ofrecen 3 botones: **Seguir comprando / Ver carrito /
  Finalizar pedido**. "Finalizar pedido" genera la proforma, vacía el
  carrito y responde con el número de cotización y los totales.

**Probado end-to-end, dos veces:** primero simulado (PowerShell + HMAC)
contra dos "Lejía", confirmando la fila en `detalle_cotizacion` y el
`cliente` creado. Después **real, desde WhatsApp del dueño** (ver §6.0.1):
búsqueda → lista → selección → carrito → finalizar → cotización creada.

### 6.0.1 Precios reales cargados (2026-07-29)

Los 144 productos tenían casi todos `precio_venta = null` (o los 4 que sí
tenían venían de datos de prueba random de §7.5). Se les asignó precio por
categoría (papel, guantes, bolsas por tamaño, lejía/limpiadores, etc.) con
rangos típicos de un mayorista de limpieza en Perú, terminaciones .90/.50.
**Son precios de referencia estimados, no verificados contra un listado
real de proveedores** — sirven para que las proformas den números
creíbles, pero hay que revisarlos/ajustarlos con precios reales antes de
mostrarle el proyecto a un cliente.

### 6.0.2 Prueba manual real vía ngrok (2026-07-29)

Se probó el flujo completo desde el WhatsApp real del dueño (no solo
simulado), usando **ngrok** para exponer `localhost:3000` a internet
mientras se desarrolla (más rápido que deployar a Vercel para iterar).

- Túnel: `ngrok http 3000` (requiere cuenta gratuita + authtoken de
  ngrok — se configuró con `ngrok config add-authtoken <token>`).
- Webhook registrado en Meta → WhatsApp → Configuración → Webhook, con la
  URL pública de ngrok + `/api/whatsapp/webhook` y el
  `WHATSAPP_VERIFY_TOKEN` de `.env.local`. Verificado OK (GET con
  `hub.challenge` respondido 200).
- **La URL de ngrok cambia cada vez que se reinicia el túnel** (plan
  gratuito) — hay que volver a registrarla en el panel de Meta cada
  sesión de pruebas. Para no repetir esto conviene deployar a Vercel más
  adelante (dominio fijo).

### 6.0.3 Bug encontrado en la prueba real: singular/plural (corregido)

El dueño probó "tienen bolsas" y encontró 1 resultado; "tienen bolsa"
encontró varios más. Causa: el catálogo tiene casi todo en singular
("Bolsa 140LT...") y un solo producto en plural ("Bolsas 240L...");
"bolsa" al ser substring de "bolsas" matcheaba de más, y "bolsas" al ser
mas especifico matcheaba de menos. Se agregó `variantesPlural()` en
`lib/whatsapp/productos.ts`: genera variantes sin "s"/"es" finales y
matchea si cualquiera aparece en el nombre. Verificado: "bolsa" y
"bolsas" devuelven ahora el mismo resultado.

**Limitación encontrada, no es bug — pendiente de la IA:** "Bolsas y
papel" (dos productos en un mismo mensaje, sin frase gatillo) no fue
reconocido. El sistema de reglas de `lib/whatsapp/intent.ts` solo
detecta intención si hay una frase gatillo ("tienen", "cuánto cuesta",
etc.) y busca **una sola frase de producto por mensaje**. Pedidos
compuestos o sin frase gatillo son justo el caso de uso para agregar IA
(Gemini, ver §9) en vez de seguir agregando reglas ad-hoc.

### 6.0.4 Ajustes de UX pedidos por el dueño tras probar en real (2026-07-29)

Tras la primera prueba real por WhatsApp, se pidieron 3 cambios:

1. **"Solo puedo tocar un producto por vez de la lista, quiero elegir
   varios."** WhatsApp no tiene selección múltiple nativa en mensajes de
   lista (limitación real de la API, no de este código). Solución: al
   agregar un producto, se **reenvía la misma lista de la última búsqueda**
   (`lib/whatsapp/ultimaBusqueda.ts`, cache en memoria por teléfono, 30 min)
   para poder tocar otro producto distinto sin volver a escribir la
   búsqueda.
2. **"No quiero que salga mi stock disponible, y ninguna venta se debe
   detener por falta de stock."** Se sacó el stock de la descripción de la
   lista y de los mensajes de texto (`lib/whatsapp/respuestas.ts`,
   `enviarListaProductos` en el webhook) — ahora solo se muestra el precio.
   Se confirmó además que el código **nunca bloqueaba** la venta por stock
   (ni al agregar al carrito ni al generar la cotización); el stock solo se
   mostraba como dato informativo, así que no hizo falta tocar esa lógica,
   solo dejar de mostrarlo.
3. **"Quiero elegir la cantidad que yo quiera, no botones fijos +1/+5/+10."**
   Primero se probó con botones rápidos, pero el dueño pidió cantidad
   libre. Los botones de WhatsApp **no admiten campos de texto** (eso solo
   existe con "WhatsApp Flows", mucho más complejo de armar) — la única
   forma de que el cliente escriba cualquier número es preguntando por
   texto plano. Se agregó `lib/whatsapp/estado.ts`: al tocar un producto de
   la lista, el bot pregunta *"¿Cuántas unidades de "X" querés? Escribí el
   número."*; el siguiente mensaje de texto de ese número se interpreta
   como la cantidad (si no es un número válido, se lo vuelve a pedir).
   `carrito.agregarItem()` ahora acepta la cantidad indicada (antes siempre
   sumaba de a 1).

Probado localmente end-to-end (buscar → tocar → responder "34" → se agrega
con cantidad 34, se reenvía la lista, aparecen los botones de acción) sin
errores de código — pendiente de reprobar en WhatsApp real desde la otra
laptop (ver §6.0.5).

### 6.0.5 ⚠️ Sesión cortada a mitad de migrar a la otra laptop (2026-07-29 noche)

**Leer esto primero si estás retomando mañana.**

Se hizo todo el trabajo de §6.0–6.0.4 en la laptop de ALU (usuario
`automatizacionia69`, carpeta `C:\Users\LUILLY PONCE\proyecto\Limpiezapro`).
Los cambios están comiteados en `main` (2 commits: uno con
respuestas/botones/carrito/proforma, otro con la selección múltiple +
cantidad libre + ocultar stock). **Hay que confirmar que ambos commits ya
se subieron a GitHub con `git push` desde GitHub Desktop** — el `git push`
por terminal fallaba por falta de credenciales interactivas.

**Estado a mitad de migrar a la otra laptop (usuario `HP`,
`C:\Users\HP\proyecto\limpiezapro`):**
- ✅ Repo clonado, `npm install` corrido.
- ✅ `.env.local` creado con los mismos valores (ver §3 / pedir a Claude si
  hace falta repetirlos — no se guardan en este archivo por seguridad,
  pero se compartieron en el chat de esa sesión).
- ✅ `npm run dev` corriendo ahí (`Ready`, puerto 3000).
- ⬜ **Falta instalar y configurar ngrok en esa laptop** (`npm install -g
  ngrok`, `ngrok config add-authtoken <token>` — mismo authtoken de la
  cuenta ngrok ya creada) y levantar el túnel (`ngrok http 3000`).
- ⬜ **Falta reconectar el webhook en Meta** con la URL nueva de ngrok (la
  URL cambia cada vez que se reinicia el túnel, incluso en la misma
  laptop) — Meta → WhatsApp → Configuración de la API → Webhook → Callback
  URL + `WHATSAPP_VERIFY_TOKEN=limpiezapro_test_token_123` → Verificar y
  guardar → confirmar que el campo "messages" siga suscrito.
- ⬜ **El `WHATSAPP_ACCESS_TOKEN` es temporal (~24h)** — probablemente ya
  venció otra vez, hay que generar uno nuevo en Meta → WhatsApp →
  Configuración de la API → Paso 1. Pruébalo, y actualizar `.env.local` en
  la laptop que se esté usando.
- ⬜ Falta volver a probar el flujo completo (buscar → tocar → cantidad
  libre → finalizar) desde WhatsApp real ya en la nueva laptop, para
  confirmar que los 3 ajustes de §6.0.4 funcionan también ahí.

## 6. Chatbot: estado y lo que falta

### 6.1 Actualización 2026-07-29 — IMPORTANTE: el ERP se mudó de repo

El ERP dejó de construirse acá y ahora vive en un **repo separado**:
`automatizacionia69/limpiezaproERP`, desplegado en
https://limpiezapro-erp.vercel.app. **Este repo (`Limpiezapro`) sigue siendo
el del chatbot únicamente.** Ambos repos comparten el mismo proyecto
Supabase (`ejfaoqudlberhkkjvqdm`) — confirmado empíricamente: la tabla
`productos` ya tiene el esquema nuevo del ERP (`unidad_id`, `categoria_id`,
`costo`, `precio_venta` como FK/columnas reales) y 144 productos reales
cargados (ya no son los 15 SKUs de prueba).

**No se toca código del repo `limpiezaproERP` desde acá.** Solo se hacen
consultas de LECTURA (`select`) a la misma base de datos desde el chatbot.

### 6.2 Pieza 7 (consulta precio/stock) — CERRADA y probada end-to-end

Se implementó:
- `lib/whatsapp/productos.ts` — reescrito para el esquema nuevo: hace join a
  `unidades_medida(nombre)` y `categorias(nombre)`, trae `precio_venta`.
- `lib/whatsapp/enviar.ts` — `enviarTexto()`, llama a la Graph API de Meta
  (`POST /{phone_number_id}/messages`) con `WHATSAPP_ACCESS_TOKEN`. No lanza
  en caso de error (el webhook igual debe responder 200 a Meta).
- `lib/whatsapp/respuestas.ts` — formatea la lista de productos encontrados
  (nombre, precio, stock) en texto para WhatsApp.
- `app/api/whatsapp/webhook/route.ts` — ahora arma la respuesta según la
  intención y la envía de verdad con `enviarTexto()`.

**Probado real:** mensaje "tienen papel higienico" → webhook → Supabase (144
productos reales) → 5 resultados con precio/stock reales → enviado por
WhatsApp Cloud API → **confirmado recibido** en +51 979 322 696 (número de
prueba, agregado a la lista de destinatarios autorizados en el panel de
Meta).

**Nota sobre el catálogo real:** no todos los productos tienen `precio_venta`
cargado (sale `null` en varios) — es un dato pendiente de completar en el
ERP, no un bug del chatbot.

**Robustez del webhook, corregida (2026-07-29):** el código original tenía
varios puntos donde un mensaje "raro" podía tumbar el procesamiento o generar
respuestas duplicadas:
- `mensaje.text.body` se leía sin chequear que existiera — un mensaje sin
  ese campo (foto, audio, sticker, ubicación, reacción) tiraba una excepción
  no controlada → 500 → Meta reintenta el webhook completo indefinidamente.
- No había `try/catch` por mensaje: un mensaje malformado dentro de un lote
  tumbaba el procesamiento de todos los demás mensajes de esa llamada.
- No había deduplicación: si el servidor tardaba en responder, Meta
  reintentaba la entrega y el cliente podía recibir la misma respuesta
  repetida.
- No había tope al tamaño del lote de mensajes por llamada.
- Los mensajes que no son texto (foto, audio, sticker, ubicación) se
  ignoraban en silencio — el cliente quedaba sin ninguna respuesta.

Se agregó: `try/catch` por mensaje (uno malo no afecta a los demás, y el
webhook siempre devuelve 200 — devolver error solo logra que Meta reintente
y duplique envíos, no arregla nada), `lib/whatsapp/dedupe.ts` (deduplica por
`id` de mensaje, ventana de 10 min en memoria), tope de 20 mensajes por
llamada, guardas de tipo antes de leer `text.body`, y una respuesta genérica
("solo puedo leer texto por ahora") para tipos de mensaje no soportados
(excepto reacciones, que no generan respuesta). Probado con lotes mixtos
(mensaje sin body + sticker + mensaje normal en la misma llamada) y con un
mismo `id` enviado dos veces simulando un reintento de Meta — en ambos casos
el comportamiento fue el esperado.

**Bug corregido (2026-07-29): tildes rompían la búsqueda.** `buscarProductos`
usaba `ilike` de PostgREST, que compara byte a byte — "lejia" (sin tilde,
como llega ya normalizado desde `intent.ts`) nunca matcheaba productos reales
guardados como "Lejía" (con tilde). Se reescribió para traer el catálogo
completo (~144 filas, entra entero en una respuesta) y filtrar en memoria
comparando ambos lados sin tildes (`normalize("NFD")` + strip de
diacríticos). De paso esto elimina la superficie de inyección que tenía el
filtro `.or()` armado por concatenación de texto. Probado con "cuanto esta la
lejia" → encuentra "Lejía gln maja" y "Lejía Bidón Hoja", enviado y
confirmado recibido por WhatsApp.

**Pendiente de esta pieza:**
- El `WHATSAPP_ACCESS_TOKEN` actual es un **token temporal de prueba (~24h)**.
  Para producción real hace falta un token de sistema permanente (Meta →
  System Users) o pasar por el flujo de verificación de negocio.
- Conectar Meta de verdad en producción requiere URL pública (Vercel) +
  registrar el webhook en el panel de Meta — sigue pendiente, hoy solo se
  probó en local.

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

⚠️ **Actualizado 2026-07-28:** la columna se llama `precio_venta` (no
`precio` como decía esta nota antes). Ver `sql/02_datos_prueba.sql`, que ya
la crea con `alter table ... add column if not exists precio_venta
numeric(10,2)`.

Falta incluir `precio_venta` en el `select` de `lib/whatsapp/productos.ts`
(todavía no se tocó ese archivo).

### 7.5 Datos de prueba cargados (2026-07-28)

> ⚠️ **ESTOS SON DATOS DE PRUEBA, NO REFLEJAN PRECIOS NI UBICACIONES
> REALES.** Reemplazar antes de mostrar el proyecto a un cliente real.

Para no bloquear el desarrollo del chatbot mientras se limpia el Excel real
(§7.2), se generó `sql/02_datos_prueba.sql` — a correr manualmente en el SQL
Editor de Supabase (yo no tengo conexión directa a la base de datos, solo
las keys REST en `.env.local`). Hace, sobre los 143 productos existentes:

- Crea las 4 zonas reales si no existen (Sala Comedor, Cochera, Cuarto 1,
  Cocina).
- Agrega la columna `precio_venta` si no existe.
- `precio_venta`: aleatorio entre S/ 3.00 y S/ 80.00.
- `zona_id`: aleatorio, distribuido entre las 4 zonas reales.
- `punto_reorden`: si estaba en 0, aleatorio entre 5 y 20.
- No toca `cantidad` ni `nombre`.
- Termina con verificación (productos sin precio/zona, distribución por
  zona).

**Pendiente de confirmar:** correr el script y pegar aquí el resultado de la
Parte 4 (verificación) una vez ejecutado.

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

**Mañana, retomar por acá primero (ver §6.0.5):**
0. Confirmar que los 2 commits pendientes se subieron a GitHub (`git push`
   vía GitHub Desktop). Terminar de configurar ngrok en la laptop nueva,
   reconectar el webhook en Meta (URL nueva) y reprobar el flujo completo
   de compra por WhatsApp (con cantidad libre, sin stock visible, y
   selección múltiple reenviando la lista).

Después de eso, el resto del roadmap sigue igual:
1. Correr `sql/01_cerrar_fuga_vistas.sql` (§7.1) — es el único riesgo de
   seguridad abierto.
2. Deploy a Vercel + registrar el webhook en Meta con una URL fija (evita
   tener que reconectar ngrok cada sesión).
3. Meter IA (Gemini) para la detección de intención — resuelve el caso de
   "pedir varios productos distintos en un mismo mensaje sin frase
   gatillo" (ver §6.0.3).
4. Recién ahí, empezar la UI del ERP (piezas 1–5) — aunque ojo: el ERP en
   sí se está construyendo en el repo separado `limpiezaproERP` (§6.1), no
   acá.
