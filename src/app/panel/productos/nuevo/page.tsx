import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { canManageProducts } from "@/lib/permissions";

import { createProduct } from "../actions";

export default async function NewProductPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [user, { error }] = await Promise.all([getCurrentUser(), searchParams]);
  const canCreate = canManageProducts(user.roles);

  return (
    <div className="module-page narrow-page">
      <div className="breadcrumb"><Link href="/panel/productos">Productos</Link><span>/</span><span>Nuevo producto</span></div>
      <section className="module-header compact">
        <div>
          <p className="eyebrow">OPERACIÓN · NUEVO PRODUCTO</p>
          <h3>Registrar tubo o producto</h3>
          <p>Registra especificaciones que permitan cotizar, producir y despachar correctamente.</p>
        </div>
      </section>

      {!canCreate ? (
        <div className="empty-card">Sólo Administración o Gerencia puede crear productos.</div>
      ) : (
        <form className="form-card" action={createProduct}>
          {error && <p className="alert" role="alert">{error}</p>}
          <div className="form-grid">
            <label>Código / SKU *<input name="sku" required maxLength={60} placeholder="TUB-600-2500" /></label>
            <label>Nombre del producto *<input name="name" required maxLength={180} placeholder="Tubo concreto 600 mm x 2.5 m" /></label>
            <label>Diámetro (mm)<input name="diameterMm" type="number" min="0" step="0.01" placeholder="600" /></label>
            <label>Longitud (mm)<input name="lengthMm" type="number" min="0" step="0.01" placeholder="2500" /></label>
            <label>Clase / resistencia<input name="strengthClass" maxLength={80} placeholder="Ej. Clase III" /></label>
            <label>Tipo de unión<input name="jointType" maxLength={80} placeholder="Ej. Espiga y campana" /></label>
            <label>Unidad de venta
              <select name="unit" defaultValue="unidad">
                <option value="unidad">Unidad</option>
                <option value="metro">Metro</option>
                <option value="juego">Juego</option>
              </select>
            </label>
            <label>Peso (kg)<input name="weightKg" type="number" min="0" step="0.01" placeholder="0" /></label>
            <label className="full-width">Descripción / observaciones<textarea name="description" rows={4} maxLength={1000} placeholder="Información adicional del producto" /></label>
          </div>
          <div className="form-actions">
            <Link className="button-secondary button-link" href="/panel/productos">Cancelar</Link>
            <button type="submit">Guardar producto</button>
          </div>
        </form>
      )}
    </div>
  );
}
