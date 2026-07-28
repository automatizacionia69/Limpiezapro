-- ============================================================================
-- 01_cerrar_fuga_vistas.sql
-- Distribuidora LimpiezaPro - correccion de seguridad
--
-- PROBLEMA
-- La vista publica.productos_stock_bajo devuelve filas a usuarios anonimos
-- (rol `anon`), aunque la tabla `productos` si tiene RLS y bloquea a `anon`.
--
-- Causa: en Postgres una vista se ejecuta por defecto con los permisos de su
-- CREADOR (comportamiento tipo SECURITY DEFINER), no con los de quien la
-- consulta. Por eso la vista "ve" productos sin que se le aplique el RLS de
-- la tabla, y le pasa esos datos a cualquiera que tenga la anon key --
-- que es publica por diseno (viaja en el JS del navegador).
--
-- Evidencia recogida en la auditoria (2026-07-27):
--   productos            -> 15 filas reales, `anon` ve 0   (correcto)
--   zonas                ->  4 filas reales, `anon` ve 0   (correcto)
--   productos_stock_bajo ->  1 fila real,   `anon` ve 1   (FUGA)
--
-- Contenido filtrado: nombre, codigo, cantidad, punto_reorden y zona del
-- producto que se esta agotando.
--
-- COMO USAR
-- Pegar este archivo completo en: Supabase -> SQL Editor -> New query -> Run.
-- Es idempotente: se puede correr varias veces sin efectos secundarios.
-- ============================================================================


-- ============================================================================
-- PARTE 1 - DIAGNOSTICO (correr ANTES de corregir, para dejar constancia)
-- ============================================================================

-- 1.1 Que vistas existen y cuales NO respetan el RLS de sus tablas base.
--     security_invoker = false  ->  la vista salta el RLS  (problema)
select
  c.relname                                        as vista,
  coalesce(
    (select option_value
       from pg_options_to_table(c.reloptions)
      where option_name = 'security_invoker'),
    'false'
  )                                                as security_invoker,
  case
    when coalesce(
      (select option_value
         from pg_options_to_table(c.reloptions)
        where option_name = 'security_invoker'), 'false') = 'true'
    then 'OK - respeta RLS'
    else 'RIESGO - salta el RLS de las tablas base'
  end                                              as estado
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('v', 'm')          -- vistas y vistas materializadas
order by c.relname;

-- 1.2 Estado del RLS en todas las tablas del esquema public.
select
  c.relname                     as tabla,
  c.relrowsecurity              as rls_habilitado,
  c.relforcerowsecurity         as rls_forzado,
  case when c.relrowsecurity
       then 'OK'
       else 'RIESGO - tabla abierta a internet'
  end                           as estado
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by c.relname;

-- 1.3 Que puede hacer exactamente el rol anonimo sobre cada objeto.
select
  table_name as objeto,
  has_table_privilege('anon', 'public.' || quote_ident(table_name), 'SELECT') as anon_select,
  has_table_privilege('anon', 'public.' || quote_ident(table_name), 'INSERT') as anon_insert,
  has_table_privilege('anon', 'public.' || quote_ident(table_name), 'UPDATE') as anon_update,
  has_table_privilege('anon', 'public.' || quote_ident(table_name), 'DELETE') as anon_delete
from information_schema.tables
where table_schema = 'public'
order by table_name;


-- ============================================================================
-- PARTE 2 - CORRECCION
-- ============================================================================

-- 2.0 `security_invoker` requiere PostgreSQL 15 o superior.
--     Si esto devuelve menos de 15, avisame: hay que cerrar la fuga por otra
--     via (recrear la vista con security_barrier + revoke, o filtrarla por
--     auth.uid()). Todo Supabase reciente corre 15+.
select current_setting('server_version') as version_postgres;

-- 2.1 Hacer que la vista se ejecute con los permisos de QUIEN la consulta.
--     Con esto el RLS de `productos` y `zonas` si se aplica, y un anonimo
--     deja de ver filas aunque llegue a tener permiso de SELECT.
alter view public.productos_stock_bajo set (security_invoker = on);

-- 2.2 Defensa en profundidad: quitarle a `anon` el acceso a la vista.
--     El modulo de alertas del ERP lo usaran usuarios logueados, no anonimos.
revoke all on public.productos_stock_bajo from anon;

-- 2.3 Asegurar que los usuarios autenticados si puedan leerla (el RLS de las
--     tablas base sigue decidiendo QUE filas ve cada rol).
grant select on public.productos_stock_bajo to authenticated;


-- ============================================================================
-- PARTE 3 - VERIFICACION (correr DESPUES; comparar con la Parte 1)
-- ============================================================================

-- 3.1 La vista debe aparecer ahora como security_invoker = true.
select
  c.relname as vista,
  coalesce(
    (select option_value
       from pg_options_to_table(c.reloptions)
      where option_name = 'security_invoker'), 'false') as security_invoker
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'productos_stock_bajo';

-- 3.2 anon_select debe ser `false` para productos_stock_bajo.
select
  'productos_stock_bajo' as objeto,
  has_table_privilege('anon', 'public.productos_stock_bajo', 'SELECT') as anon_select,
  has_table_privilege('authenticated', 'public.productos_stock_bajo', 'SELECT') as auth_select;


-- ============================================================================
-- PARTE 4 - AUDITORIA DE POLITICAS RLS (pendiente de la revision anterior)
--
-- Estas consultas NO cambian nada: solo listan. En la auditoria no pude leer
-- las politicas (sin acceso SQL solo pude probar el comportamiento de `anon`),
-- asi que faltaba confirmar que los roles admin / almacen / ventas esten bien
-- definidos. Copiar el resultado y pasarmelo para revisarlo.
-- ============================================================================

-- 4.1 Todas las politicas RLS definidas, con su condicion.
select
  tablename    as tabla,
  policyname   as politica,
  cmd          as operacion,     -- SELECT / INSERT / UPDATE / DELETE / ALL
  permissive   as tipo,
  roles        as roles_afectados,
  qual         as condicion_lectura,   -- USING
  with_check   as condicion_escritura  -- WITH CHECK
from pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;

-- 4.2 Tablas con RLS habilitado pero SIN ninguna politica.
--     (bloquean todo salvo service_role: puede ser intencional o un olvido)
select c.relname as tabla_con_rls_sin_politicas
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relrowsecurity
  and not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname
  )
order by c.relname;
