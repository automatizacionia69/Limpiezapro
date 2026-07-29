import { supabaseAdmin } from "@/lib/supabase/admin";

export interface ProductoEncontrado {
  id: number;
  nombre: string;
  codigo: string | null;
  cantidad: number;
  precio_venta: number | null;
  unidad: string;
  categoria: string | null;
  zona_id: number | null;
}

interface FilaProducto {
  id: number;
  nombre: string;
  codigo: string | null;
  cantidad: number;
  precio_venta: number | null;
  zona_id: number | null;
  unidades_medida: { nombre: string } | { nombre: string }[] | null;
  categorias: { nombre: string } | { nombre: string }[] | null;
}

/** Tope de palabras por busqueda: evita comparaciones gigantes desde un mensaje largo. */
const MAX_PALABRAS = 6;
/** Tope de caracteres por palabra. */
const MAX_LARGO_PALABRA = 40;
/** Tope de filas del catalogo a traer. El catalogo real tiene ~144 productos. */
const MAX_CATALOGO = 1000;
/** Tope de resultados devueltos por busqueda (no el limite de WhatsApp por mensaje, ver enviarListaProductos). */
const MAX_RESULTADOS = 30;

const COLUMNAS =
  "id, nombre, codigo, cantidad, precio_venta, zona_id, unidades_medida(nombre), categorias(nombre)";

function sanitizarTermino(palabra: string): string {
  return palabra.replace(/[^\p{L}\p{N}\s-]/gu, "").trim();
}

function mapearFila(fila: FilaProducto): ProductoEncontrado {
  const unidad = Array.isArray(fila.unidades_medida)
    ? fila.unidades_medida[0]?.nombre
    : fila.unidades_medida?.nombre;
  const categoria = Array.isArray(fila.categorias)
    ? fila.categorias[0]?.nombre
    : fila.categorias?.nombre;

  return {
    id: fila.id,
    nombre: fila.nombre,
    codigo: fila.codigo,
    cantidad: fila.cantidad,
    precio_venta: fila.precio_venta,
    zona_id: fila.zona_id,
    unidad: unidad ?? "unidad",
    categoria: categoria ?? null,
  };
}

/** Quita tildes/diacriticos para que "lejia" matchee "Lejía" y viceversa. */
function sinTildes(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Variantes de una palabra para que singular/plural encuentren lo mismo.
 * Ej: "bolsas" -> ["bolsas", "bolsa"]. Sin esto, "bolsa" (substring de
 * "bolsas") matcheaba mas productos que "bolsas" mismo — el catalogo tiene
 * casi todo en singular ("Bolsa 140LT...") y un solo producto en plural
 * ("Bolsas 240L..."), asi que buscar en plural quedaba casi vacio.
 */
function variantesPlural(palabra: string): string[] {
  const variantes = new Set([palabra]);
  if (palabra.length > 4 && palabra.endsWith("es")) {
    variantes.add(palabra.slice(0, -2));
  }
  if (palabra.length > 3 && palabra.endsWith("s")) {
    variantes.add(palabra.slice(0, -1));
  }
  return [...variantes];
}

/**
 * Busca por coincidencia de substring ignorando mayusculas/tildes.
 *
 * El filtrado se hace en memoria (no con `ilike` en Postgres) por dos motivos:
 * el catalogo es chico (~144 filas, cabe entero en una respuesta) y `ilike`
 * compara byte a byte, asi que un cliente que escribe "lejia" nunca matchea
 * un producto guardado como "Lejía" — hay que normalizar tildes en ambos
 * lados, y eso no se puede expresar como filtro de PostgREST.
 */
export async function buscarProductos(
  texto: string
): Promise<ProductoEncontrado[]> {
  const palabras = texto
    .split(/\s+/)
    .map((p) => sanitizarTermino(p))
    .filter((p) => p.length >= 3 && p.length <= MAX_LARGO_PALABRA)
    .slice(0, MAX_PALABRAS)
    .map(sinTildes);

  if (palabras.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("productos")
    .select(COLUMNAS)
    .limit(MAX_CATALOGO);

  if (error) {
    console.error("Error buscando productos en Supabase:", error);
    return [];
  }

  if (!data) return [];

  const productos = (data as unknown as FilaProducto[]).map(mapearFila);

  return productos
    .map((producto) => {
      const nombreNormalizado = sinTildes(producto.nombre);
      const coincidencias = palabras.filter((p) =>
        variantesPlural(p).some((variante) => nombreNormalizado.includes(variante))
      ).length;
      return { producto, coincidencias };
    })
    .filter((r) => r.coincidencias > 0)
    .sort((a, b) => b.coincidencias - a.coincidencias)
    .slice(0, MAX_RESULTADOS)
    .map((r) => r.producto);
}

/** Trae un producto puntual (precio/stock al momento de la seleccion en la lista interactiva). */
export async function obtenerProductoPorId(
  id: number
): Promise<ProductoEncontrado | null> {
  const { data, error } = await supabaseAdmin
    .from("productos")
    .select(COLUMNAS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("Error obteniendo producto por id:", error);
    return null;
  }
  if (!data) return null;

  return mapearFila(data as unknown as FilaProducto);
}
