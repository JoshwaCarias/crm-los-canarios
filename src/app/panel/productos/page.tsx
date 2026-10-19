import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { canManageProducts } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

type Product = {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  diameter_mm: number | string | null;
  length_mm: number | string | null;
  strength_class: string | null;
  joint_type: string | null;
  unit: string;
  weight_kg: number | string | null;
  is_active: boolean;
};

function matchesSearch(product: Product, query: string) {
  if (!query) return true;
  const haystack = [product.sku, product.name, product.description, product.strength_class, product.joint_type]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("es-GT");
  return haystack.includes(query.toLocaleLowerCase("es-GT"));
}

function productSpecs(product: Product) {
  const specs = [
    product.diameter_mm !== null ? `Ø ${product.diameter_mm} mm` : null,
    product.length_mm !== null ? `${product.length_mm} mm largo` : null,
    product.strength_class,
    product.joint_type,
  ].filter(Boolean);
  return specs.length ? specs.join(" · ") : "Sin especificaciones dimensionales";
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; created?: string; error?: string }>;
}) {
  const [{ q, created, error }, user, supabase] = await Promise.all([searchParams, getCurrentUser(), createClient()]);
  const { data, error: queryError } = await supabase
    .from("products")
    .select("id, sku, name, description, diameter_mm, length_mm, strength_class, joint_type, unit, weight_kg, is_active")
    .order("name")
    .limit(100);

  const products = ((data ?? []) as Product[]).filter((product) => matchesSearch(product, q ?? ""));
  const canCreate = canManageProducts(user.roles);

  return (
    <div className="module-page">
      <section className="module-header">
        <div>
          <p className="eyebrow">OPERACIÓN · CATÁLOGO</p>
          <h3>Productos</h3>
          <p>Define los tubos de concreto y sus especificaciones para ventas, planta y despacho.</p>
        </div>
        {canCreate && <Link className="button-link" href="/panel/productos/nuevo">Nuevo producto</Link>}
      </section>

      {created === "1" && <p className="notice success">Producto creado correctamente.</p>}
      {error && <p className="alert" role="alert">{error}</p>}

      <form className="search-bar" action="/panel/productos" method="get">
        <label htmlFor="product-search">Buscar por código, nombre, clase o tipo de unión</label>
        <div>
          <input id="product-search" name="q" defaultValue={q ?? ""} placeholder="Ej. TUB-600, Clase III" />
          <button type="submit" className="button-secondary">Buscar</button>
        </div>
      </form>

      {queryError ? (
        <div className="empty-card">No fue posible cargar los productos. Revisa los permisos de Supabase.</div>
      ) : products.length === 0 ? (
        <div className="empty-card">{q ? "No encontramos productos que coincidan con la búsqueda." : "Aún no hay productos registrados."}</div>
      ) : (
        <div className="product-grid">
          {products.map((product) => (
            <article className="product-card" key={product.id}>
              <div className="product-card-head">
                <span className="sku">{product.sku}</span>
                <span className={`status-pill ${product.is_active ? "active" : "inactive"}`}>{product.is_active ? "Activo" : "Inactivo"}</span>
              </div>
              <h4>{product.name}</h4>
              <p>{productSpecs(product)}</p>
              <dl>
                <div><dt>Unidad</dt><dd>{product.unit}</dd></div>
                <div><dt>Peso</dt><dd>{product.weight_kg !== null ? `${product.weight_kg} kg` : "—"}</dd></div>
              </dl>
              {product.description && <small>{product.description}</small>}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
