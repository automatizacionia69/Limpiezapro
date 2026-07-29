-- ============================================================================
-- 02_datos_prueba.sql
-- Distribuidora LimpiezaPro - datos de prueba controlados
--
-- OBJETIVO
-- Poder seguir desarrollando el chatbot (precio, zona, alertas de stock bajo)
-- sin esperar a limpiar e importar el Excel real (~140 SKUs).
--
-- ============================================================================
--   ATENCION: ESTOS SON DATOS DE PRUEBA. NO REFLEJAN PRECIOS NI UBICACIONES
--   REALES. Hay que reemplazarlos antes de mostrar el proyecto a un cliente
--   real (ver RESUMEN.md S7.2, importacion del inventario real).
-- ============================================================================
--
-- QUE HACE
--   1. Crea las 4 zonas reales si no existen (Sala Comedor, Cochera,
--      Cuarto 1, Cocina). No las duplica si ya existen.
--   2. Agrega la columna productos.precio_venta si no existe todavia.
--   3. Actualiza TODOS los productos existentes:
--        - precio_venta: aleatorio entre 3.00 y 80.00 soles (2 decimales)
--        - zona_id: aleatorio, distribuido entre las 4 zonas reales
--        - punto_reorden: si esta en 0 (o null), aleatorio entre 5 y 20
--   4. NO toca `cantidad` ni `nombre` (esos datos ya son correctos).
--   5. Corre verificacion: productos sin precio/zona (debe ser 0) y
--      distribucion de productos por zona.
--
-- COMO USAR
-- Pegar este archivo completo en: Supabase -> SQL Editor -> New query -> Run.
-- Es idempotente en las partes 1 y 2 (no duplica zonas ni columnas).
-- La parte 3 SI vuelve a aleatorizar los valores cada vez que se corre -
-- no la vuelvas a correr si ya empezaste a probar el chatbot con estos datos.
-- ============================================================================


-- ============================================================================
-- PARTE 1 - ZONAS: crear las 4 reales si no existen
-- ============================================================================

insert into public.zonas (nombre)
select v.nombre
from (values ('Sala Comedor'), ('Cochera'), ('Cuarto 1'), ('Cocina')) as v(nombre)
where not exists (
  select 1 from public.zonas z where z.nombre = v.nombre
);

-- Confirmacion: deberian aparecer exactamente estas 4.
select id, nombre from public.zonas order by id;


-- ============================================================================
-- PARTE 2 - COLUMNA precio_venta
-- ============================================================================

alter table public.productos
  add column if not exists precio_venta numeric(10, 2);


-- ============================================================================
-- PARTE 3 - GENERAR DATOS DE PRUEBA (aleatorio)
-- ============================================================================

-- 3.1 Precio: aleatorio entre 3.00 y 80.00 soles, 2 decimales.
update public.productos
set precio_venta = round((random() * (80 - 3) + 3)::numeric, 2);

-- 3.2 Zona: aleatoria, distribuida entre las 4 zonas reales.
--     El subquery se re-evalua por fila porque random() es volatil.
update public.productos
set zona_id = (
  select id
  from public.zonas
  where nombre in ('Sala Comedor', 'Cochera', 'Cuarto 1', 'Cocina')
  order by random()
  limit 1
);

-- 3.3 Punto de reorden: solo si esta en 0 o vacio, aleatorio entre 5 y 20.
update public.productos
set punto_reorden = floor(random() * (20 - 5 + 1) + 5)::int
where punto_reorden = 0 or punto_reorden is null;


-- ============================================================================
-- PARTE 4 - VERIFICACION
-- ============================================================================

-- 4.1 Productos sin precio o sin zona (debe dar 0 en ambos).
select 'sin_precio_venta' as chequeo, count(*) as cantidad
from public.productos
where precio_venta is null
union all
select 'sin_zona' as chequeo, count(*) as cantidad
from public.productos
where zona_id is null;

-- 4.2 Distribucion de productos por zona.
select
  z.nombre as zona,
  count(p.id) as cantidad_productos
from public.zonas z
left join public.productos p on p.zona_id = z.id
group by z.nombre
order by z.nombre;

-- 4.3 Total de productos actualizados (deberian ser 143).
select count(*) as total_productos from public.productos;
