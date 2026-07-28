import { supabaseAdmin } from "@/lib/supabase/admin";

export interface ProductoEncontrado {
  id: number;
  nombre: string;
  codigo: string;
  cantidad: number;
  unidad: string;
  categoria: string | null;
  zona_id: number;
}

/** Tope de palabras por busqueda: evita queries gigantes desde un mensaje largo. */
const MAX_PALABRAS = 6;
/** Tope de caracteres por palabra. */
const MAX_LARGO_PALABRA = 40;

/**
 * Deja solo letras, numeros, espacios y guiones.
 *
 * Es la frontera de seguridad de esta funcion: el filtro `or` de PostgREST se
 * arma concatenando texto, asi que cualquier metacaracter que llegue hasta ahi
 * deja al cliente controlar la ESTRUCTURA de la query, no solo el valor:
 *   - `,`      cierra la condicion e inyecta otra  -> `nombre.ilike.%x%,id.gt.0`
 *   - `()`     reagrupan condiciones and/or
 *   - `%` `_`  son comodines LIKE: `%%%` hace match con todo el catalogo
 * Como esto corre con la service_role (sin RLS), no se puede depender de que
 * otro modulo haya limpiado el texto antes.
 */
function sanitizarTermino(palabra: string): string {
  return palabra.replace(/[^\p{L}\p{N}\s-]/gu, "").trim();
}

export async function buscarProductos(
  texto: string
): Promise<ProductoEncontrado[]> {
  const palabras = texto
    .split(/\s+/)
    .map((p) => sanitizarTermino(p))
    .filter((p) => p.length >= 3 && p.length <= MAX_LARGO_PALABRA)
    .slice(0, MAX_PALABRAS);

  if (palabras.length === 0) return [];

  const filtro = palabras.map((p) => `nombre.ilike.%${p}%`).join(",");

  const { data, error } = await supabaseAdmin
    .from("productos")
    .select("id, nombre, codigo, cantidad, unidad, categoria, zona_id")
    .or(filtro)
    .limit(20);

  if (error) {
    console.error("Error buscando productos en Supabase:", error);
    return [];
  }

  if (!data) return [];

  return data
    .map((producto) => {
      const nombreLower = producto.nombre.toLowerCase();
      const coincidencias = palabras.filter((p) =>
        nombreLower.includes(p.toLowerCase())
      ).length;
      return { producto, coincidencias };
    })
    .sort((a, b) => b.coincidencias - a.coincidencias)
    .slice(0, 5)
    .map((r) => r.producto);
}
