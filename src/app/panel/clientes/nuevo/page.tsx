import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { canManageCustomers } from "@/lib/permissions";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

import { createCustomer } from "../actions";

export default async function NewCustomerPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [user, { error }, supabase] = await Promise.all([getCurrentUser(), searchParams, createClient()]);
  const canCreate = canManageCustomers(user.roles);
  const canSetCredit = hasAnyRole(user.roles, ["admin", "manager"]);
  const canAssignSeller = user.roles.includes("admin");
  const sellersResult = canAssignSeller
    ? await supabase.from("seller_directory").select("id, full_name").order("full_name")
    : { data: [] as { id: string; full_name: string }[] };
  const sellers = (sellersResult.data ?? []) as { id: string; full_name: string }[];

  return (
    <div className="module-page narrow-page">
      <div className="breadcrumb"><Link href="/panel/clientes">Clientes</Link><span>/</span><span>Nuevo cliente</span></div>
      <section className="module-header compact">
        <div>
          <p className="eyebrow">VENTAS · NUEVO REGISTRO</p>
          <h3>Registrar cliente</h3>
          <p>Los campos con asterisco son obligatorios.</p>
        </div>
      </section>

      {!canCreate ? (
        <div className="empty-card">No tienes permiso para crear clientes.</div>
      ) : (
        <form className="form-card" action={createCustomer}>
          {error && <p className="alert" role="alert">{error}</p>}
          <div className="form-grid">
            <label className="full-width">Razón social *
              <input name="legalName" maxLength={180} required placeholder="Ej. Constructora Ejemplo, S.A." />
            </label>
            <label>Nombre comercial
              <input name="tradeName" maxLength={180} placeholder="Si es distinto de la razón social" />
            </label>
            <label>NIT *
              <input name="nit" maxLength={30} required placeholder="1234567-8" />
            </label>
            <label>Teléfono
              <input name="phone" maxLength={40} type="tel" placeholder="0000-0000" />
            </label>
            <label>Correo electrónico
              <input name="email" maxLength={120} type="email" placeholder="compras@empresa.com" />
            </label>
            {canAssignSeller && <label className="full-width">Vendedor responsable
              <select name="assignedSellerId" defaultValue="">
                <option value="">Asignar posteriormente</option>
                {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.full_name}</option>)}
              </select>
            </label>}
            {canSetCredit && <>
              <label>Límite de crédito (GTQ)
                <input name="creditLimit" type="number" min="0" step="0.01" placeholder="0.00" />
              </label>
              <label>Días de crédito
                <input name="creditDays" type="number" min="0" step="1" placeholder="0" />
              </label>
            </>}
          </div>
          {!canSetCredit && <p className="form-help">El crédito inicia en cero y se autoriza posteriormente por Contabilidad o Gerencia.</p>}
          <div className="form-actions">
            <Link className="button-secondary button-link" href="/panel/clientes">Cancelar</Link>
            <button type="submit">Guardar cliente</button>
          </div>
        </form>
      )}
    </div>
  );
}
