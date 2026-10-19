import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { canManageCustomers } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

type Customer = {
  id: string;
  legal_name: string;
  trade_name: string | null;
  nit: string;
  phone: string | null;
  email: string | null;
  credit_limit: number | string;
  credit_days: number;
  assigned_seller_id: string | null;
  is_active: boolean;
  created_at: string;
};

const money = new Intl.NumberFormat("es-GT", {
  style: "currency",
  currency: "GTQ",
  minimumFractionDigits: 2,
});

function matchesSearch(customer: Customer, query: string) {
  if (!query) return true;
  const haystack = [customer.legal_name, customer.trade_name, customer.nit, customer.phone, customer.email]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("es-GT");
  return haystack.includes(query.toLocaleLowerCase("es-GT"));
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; created?: string; error?: string }>;
}) {
  const [{ q, created, error }, user, supabase] = await Promise.all([
    searchParams,
    getCurrentUser(),
    createClient(),
  ]);
  const { data, error: queryError } = await supabase
    .from("customers")
    .select("id, legal_name, trade_name, nit, phone, email, credit_limit, credit_days, assigned_seller_id, is_active, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  const customers = ((data ?? []) as Customer[]).filter((customer) => matchesSearch(customer, q ?? ""));
  const canCreate = canManageCustomers(user.roles);
  const sellerIds = [...new Set(customers.map((customer) => customer.assigned_seller_id).filter((sellerId): sellerId is string => Boolean(sellerId)))];
  const customerIds = customers.map((customer) => customer.id);
  const [sellersResult, followUpsResult] = await Promise.all([
    sellerIds.length ? supabase.from("profiles").select("id, full_name").in("id", sellerIds) : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    customerIds.length ? supabase.from("customer_follow_ups").select("customer_id, created_at, next_follow_up_date").in("customer_id", customerIds).order("created_at", { ascending: false }).limit(1000) : Promise.resolve({ data: [] as { customer_id: string; created_at: string; next_follow_up_date: string | null }[] }),
  ]);
  const sellerNames = new Map(((sellersResult.data ?? []) as { id: string; full_name: string }[]).map((seller) => [seller.id, seller.full_name]));
  const lastFollowUp = new Map<string, { created_at: string; next_follow_up_date: string | null }>();
  for (const followUp of (followUpsResult.data ?? []) as { customer_id: string; created_at: string; next_follow_up_date: string | null }[]) {
    if (!lastFollowUp.has(followUp.customer_id)) lastFollowUp.set(followUp.customer_id, followUp);
  }

  return (
    <div className="module-page">
      <section className="module-header">
        <div>
          <p className="eyebrow">VENTAS · CATÁLOGO</p>
          <h3>Clientes</h3>
          <p>Consulta datos comerciales, contactos y obras o direcciones de entrega.</p>
        </div>
        {canCreate && <Link className="button-link" href="/panel/clientes/nuevo">Nuevo cliente</Link>}
      </section>

      {created === "1" && <p className="notice success">Cliente creado correctamente.</p>}
      {error && <p className="alert" role="alert">{error}</p>}

      <form className="search-bar" action="/panel/clientes" method="get">
        <label htmlFor="customer-search">Buscar por nombre, NIT, correo o teléfono</label>
        <div>
          <input id="customer-search" name="q" defaultValue={q ?? ""} placeholder="Ej. Constructora, 1234567-8" />
          <button type="submit" className="button-secondary">Buscar</button>
        </div>
      </form>

      {queryError ? (
        <div className="empty-card">No fue posible cargar los clientes. Revisa los permisos de Supabase.</div>
      ) : customers.length === 0 ? (
        <div className="empty-card">
          {q ? "No encontramos clientes que coincidan con la búsqueda." : "Aún no hay clientes registrados."}
        </div>
      ) : (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>NIT</th>
                <th>Contacto</th>
                <th>Crédito</th>
                <th>Vendedor</th>
                <th>Último seguimiento</th>
                <th>Estado</th>
                <th><span className="sr-only">Acción</span></th>
              </tr>
            </thead>
            <tbody>
              {customers.map((customer) => (
                <tr key={customer.id}>
                  <td>
                    <strong>{customer.legal_name}</strong>
                    {customer.trade_name && <small>{customer.trade_name}</small>}
                  </td>
                  <td>{customer.nit}</td>
                  <td>
                    <span>{customer.phone ?? "—"}</span>
                    {customer.email && <small>{customer.email}</small>}
                  </td>
                  <td>
                    <strong>{money.format(Number(customer.credit_limit))}</strong>
                    <small>{customer.credit_days} días</small>
                  </td>
                  <td>{customer.assigned_seller_id ? sellerNames.get(customer.assigned_seller_id) ?? "No disponible" : "Sin asignar"}</td>
                  <td>{lastFollowUp.get(customer.id) ? new Intl.DateTimeFormat("es-GT", { dateStyle: "medium", timeZone: "America/Guatemala" }).format(new Date(lastFollowUp.get(customer.id)!.created_at)) : "Sin seguimiento"}</td>
                  <td><span className={`status-pill ${customer.is_active ? "active" : "inactive"}`}>{customer.is_active ? "Activo" : "Inactivo"}</span></td>
                  <td><Link className="text-link" href={`/panel/clientes/${customer.id}`}>Ver ficha</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {customers.length === 100 && <p className="list-note">Se muestran los primeros 100 resultados. Usa el buscador para acotar la lista.</p>}
    </div>
  );
}
