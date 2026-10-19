import Link from "next/link";
import { notFound } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { canManageCustomers } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { DeliverySiteForm } from "../delivery-site-form";
import { addCustomerContact, addCustomerFollowUp, addDeliverySite, updateCustomerDiscount, updateCustomerSeller } from "../actions";

type Customer = {
  id: string;
  legal_name: string;
  trade_name: string | null;
  nit: string;
  phone: string | null;
  email: string | null;
  credit_limit: number | string;
  credit_days: number;
  authorized_discount_percentage: number | string;
  assigned_seller_id: string | null;
  is_active: boolean;
};

type Contact = {
  id: string;
  full_name: string;
  job_title: string | null;
  phone: string | null;
  email: string | null;
  is_primary: boolean;
};

type DeliverySite = {
  id: string;
  name: string;
  address: string;
  municipality: string | null;
  department: string | null;
  delivery_notes: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
  is_active: boolean;
};

type Quote = {
  id: string;
  quote_number: string;
  status: string;
  issue_date: string;
  valid_until: string | null;
  total: number | string;
  authorized_discount_percentage: number | string;
  seller_id: string;
};

type SalesOrder = {
  id: string;
  order_number: string;
  status: string;
  requested_delivery_date: string | null;
  total: number | string;
  created_at: string;
};

type Profile = { id: string; full_name: string };
type SellerDirectory = { id: string; full_name: string };
type FollowUp = { id: string; seller_id: string; follow_up_type: string; notes: string; next_follow_up_date: string | null; created_at: string };

const money = new Intl.NumberFormat("es-GT", { style: "currency", currency: "GTQ" });
const shortDate = new Intl.DateTimeFormat("es-GT", { dateStyle: "medium", timeZone: "America/Guatemala" });

const quoteStatus: Record<string, string> = {
  draft: "Borrador", sent: "Enviada", accepted: "Aceptada", rejected: "Rechazada", expired: "Vencida", cancelled: "Cancelada",
};
const orderStatus: Record<string, string> = {
  draft: "Borrador", pending_approval: "Pendiente de aprobación", approved: "Aprobado", pending_fulfillment: "Pendiente de preparación",
  ready_for_dispatch: "Listo para despacho", partially_delivered: "Entrega parcial", delivered: "Entregado", invoiced: "Facturado", closed: "Cerrado", cancelled: "Cancelado",
};
const followUpLabels: Record<string, string> = { call: "Llamada", whatsapp: "WhatsApp", email: "Correo", visit: "Visita", other: "Otro" };

function displayDate(date: string | null) {
  return date ? shortDate.format(new Date(`${date}T12:00:00`)) : "—";
}

function googleMapsLink(latitude: number | string, longitude: number | string) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitude},${longitude}`)}`;
}

function openStreetMapEmbed(latitude: number | string, longitude: number | string) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  const margin = 0.004;
  const bbox = `${lng - margin},${lat - margin},${lng + margin},${lat + margin}`;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(`${lat},${lng}`)}`;
}

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; contact?: string; site?: string; discount?: string; seller?: string; followup?: string }>;
}) {
  const [{ id }, messages, user, supabase] = await Promise.all([params, searchParams, getCurrentUser(), createClient()]);
  const [customerResult, contactsResult, sitesResult, ordersCountResult, deliveredOrdersCountResult, quotesCountResult, quotesResult, ordersResult, followUpsResult, sellerDirectoryResult] = await Promise.all([
    supabase.from("customers").select("id, legal_name, trade_name, nit, phone, email, credit_limit, credit_days, authorized_discount_percentage, assigned_seller_id, is_active").eq("id", id).maybeSingle(),
    supabase.from("customer_contacts").select("id, full_name, job_title, phone, email, is_primary").eq("customer_id", id).order("is_primary", { ascending: false }).order("full_name"),
    supabase.from("delivery_sites").select("id, name, address, municipality, department, delivery_notes, latitude, longitude, is_active").eq("customer_id", id).eq("is_active", true).order("name"),
    supabase.from("sales_orders").select("id", { count: "exact", head: true }).eq("customer_id", id),
    supabase.from("sales_orders").select("id", { count: "exact", head: true }).eq("customer_id", id).in("status", ["delivered", "invoiced", "closed"]),
    supabase.from("quotes").select("id", { count: "exact", head: true }).eq("customer_id", id),
    supabase.from("quotes").select("id, quote_number, status, issue_date, valid_until, total, authorized_discount_percentage, seller_id").eq("customer_id", id).order("created_at", { ascending: false }).limit(10),
    supabase.from("sales_orders").select("id, order_number, status, requested_delivery_date, total, created_at").eq("customer_id", id).order("created_at", { ascending: false }).limit(10),
    supabase.from("customer_follow_ups").select("id, seller_id, follow_up_type, notes, next_follow_up_date, created_at").eq("customer_id", id).order("created_at", { ascending: false }).limit(8),
    supabase.from("seller_directory").select("id, full_name").order("full_name"),
  ]);

  const customer = customerResult.data as Customer | null;
  if (!customer) notFound();

  const contacts = (contactsResult.data ?? []) as Contact[];
  const sites = (sitesResult.data ?? []) as DeliverySite[];
  const quotes = (quotesResult.data ?? []) as Quote[];
  const orders = (ordersResult.data ?? []) as SalesOrder[];
  const followUps = (followUpsResult.data ?? []) as FollowUp[];
  const sellerDirectory = (sellerDirectoryResult.data ?? []) as SellerDirectory[];
  const sellerIds = [...new Set([customer.assigned_seller_id, ...quotes.map((quote) => quote.seller_id), ...followUps.map((followUp) => followUp.seller_id)].filter((sellerId): sellerId is string => Boolean(sellerId)))];
  const profilesResult = sellerIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", sellerIds)
    : { data: [] as Profile[] };
  const sellers = new Map(((profilesResult.data ?? []) as Profile[]).map((profile) => [profile.id, profile.full_name]));
  const canEdit = canManageCustomers(user.roles);
  const canChangeDiscount = user.roles.includes("admin");
  const assignedSeller = customer.assigned_seller_id ? sellers.get(customer.assigned_seller_id) ?? "Vendedor no disponible" : "Sin vendedor asignado";
  const latestQuote = quotes[0];
  const latestFollowUp = followUps[0];

  return (
    <div className="module-page">
      <div className="breadcrumb"><Link href="/panel/clientes">Clientes</Link><span>/</span><span>{customer.legal_name}</span></div>
      <section className="customer-summary">
        <div>
          <p className="eyebrow">FICHA DE CLIENTE</p>
          <h3>{customer.legal_name}</h3>
          {customer.trade_name && <p>{customer.trade_name}</p>}
          <span className={`status-pill ${customer.is_active ? "active" : "inactive"}`}>{customer.is_active ? "Activo" : "Inactivo"}</span>
        </div>
        <dl>
          <div><dt>NIT</dt><dd>{customer.nit}</dd></div>
          <div><dt>Teléfono</dt><dd>{customer.phone ?? "—"}</dd></div>
          <div><dt>Correo</dt><dd>{customer.email ?? "—"}</dd></div>
          <div><dt>Crédito autorizado</dt><dd>{money.format(Number(customer.credit_limit))} · {customer.credit_days} días</dd></div>
          <div><dt>Vendedor responsable</dt><dd>{assignedSeller}</dd></div>
        </dl>
      </section>

      {messages.error && <p className="alert" role="alert">{messages.error}</p>}
      {messages.contact === "1" && <p className="notice success">Contacto agregado correctamente.</p>}
      {messages.site === "1" && <p className="notice success">Obra o dirección de entrega agregada correctamente.</p>}
      {messages.discount === "1" && <p className="notice success">Descuento autorizado actualizado correctamente.</p>}
      {messages.seller === "1" && <p className="notice success">Vendedor responsable actualizado correctamente.</p>}
      {messages.followup === "1" && <p className="notice success">Seguimiento registrado correctamente.</p>}

      <section className="customer-metrics" aria-label="Resumen comercial del cliente">
        <article><span>Pedidos realizados</span><strong>{ordersCountResult.count ?? 0}</strong><p>Historial total de pedidos.</p></article>
        <article><span>Pedidos entregados</span><strong>{deliveredOrdersCountResult.count ?? 0}</strong><p>Incluye entregados, facturados y cerrados.</p></article>
        <article><span>Cotizaciones realizadas</span><strong>{quotesCountResult.count ?? 0}</strong><p>Documentos comerciales emitidos.</p></article>
        <article className="discount-metric"><span>Descuento autorizado</span><strong>{Number(customer.authorized_discount_percentage)}%</strong><p>Máximo disponible en nuevas cotizaciones.</p></article>
      </section>

      {canChangeDiscount && (
        <form className="discount-form" action={updateCustomerDiscount}>
          <input type="hidden" name="customerId" value={customer.id} />
          <div>
            <strong>Autorizar descuento para cotizaciones</strong>
            <small>El valor predeterminado es 5%. Aplica a cotizaciones creadas después del cambio.</small>
          </div>
          <label>Porcentaje máximo
            <input name="authorizedDiscountPercentage" type="number" min="0" max="100" step="0.01" defaultValue={String(customer.authorized_discount_percentage)} required />
          </label>
          <button type="submit">Actualizar descuento</button>
        </form>
      )}

      <section className="relationship-grid">
        <article><span>Vendedor responsable</span><strong>{assignedSeller}</strong><p>La cartera del cliente queda bajo este vendedor.</p></article>
        <article><span>Última cotización</span><strong>{latestQuote ? latestQuote.quote_number : "Sin cotizaciones"}</strong><p>{latestQuote ? `${displayDate(latestQuote.issue_date)} · ${sellers.get(latestQuote.seller_id) ?? "Vendedor no disponible"}` : "Aún no se ha cotizado."}</p></article>
        <article><span>Último seguimiento</span><strong>{latestFollowUp ? followUpLabels[latestFollowUp.follow_up_type] ?? latestFollowUp.follow_up_type : "Sin seguimiento"}</strong><p>{latestFollowUp ? `${displayDate(latestFollowUp.created_at.slice(0, 10))} · ${sellers.get(latestFollowUp.seller_id) ?? "Vendedor"}` : "Registra una llamada, visita o mensaje."}</p></article>
      </section>

      {canChangeDiscount && (
        <form className="assignment-form" action={updateCustomerSeller}>
          <input type="hidden" name="customerId" value={customer.id} />
          <div><strong>Asignar vendedor responsable</strong><small>La asignación controla la cartera y las cotizaciones del cliente.</small></div>
          <select name="sellerId" defaultValue={customer.assigned_seller_id ?? ""}><option value="">Sin asignar</option>{sellerDirectory.map((seller) => <option key={seller.id} value={seller.id}>{seller.full_name}</option>)}</select>
          <button type="submit">Guardar asignación</button>
        </form>
      )}

      <section className="follow-up-section">
        <div className="section-heading"><h3>Seguimiento comercial</h3><span>Registra la actividad que mantiene activa la relación con el cliente.</span></div>
        {followUps.length ? <div className="follow-up-list">{followUps.map((followUp) => <article key={followUp.id}><div><span className="mini-tag">{followUpLabels[followUp.follow_up_type] ?? followUp.follow_up_type}</span><strong>{sellers.get(followUp.seller_id) ?? "Vendedor"}</strong><small>{new Intl.DateTimeFormat("es-GT", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Guatemala" }).format(new Date(followUp.created_at))}</small></div><p>{followUp.notes}</p>{followUp.next_follow_up_date && <small>Próximo seguimiento: {displayDate(followUp.next_follow_up_date)}</small>}</article>)}</div> : <div className="empty-inline">No se han registrado seguimientos para este cliente.</div>}
        {canEdit && <form className="follow-up-form" action={addCustomerFollowUp}><input type="hidden" name="customerId" value={customer.id} /><label>Tipo<select name="followUpType" defaultValue="call"><option value="call">Llamada</option><option value="whatsapp">WhatsApp</option><option value="email">Correo</option><option value="visit">Visita</option><option value="other">Otro</option></select></label><label className="follow-up-notes">Resultado / nota *<input name="notes" maxLength={1200} required placeholder="Ej. Se compartió cotización; solicitará confirmación el viernes." /></label><label>Próximo seguimiento<input name="nextFollowUpDate" type="date" /></label><button type="submit">Registrar seguimiento</button></form>}
      </section>

      <div className="detail-grid">
        <section className="detail-section">
          <div className="section-heading"><h3>Contactos</h3><span>{contacts.length} registrados</span></div>
          {contacts.length ? (
            <div className="record-list">
              {contacts.map((contact) => (
                <article key={contact.id}>
                  <strong>{contact.full_name}</strong>
                  {contact.is_primary && <span className="mini-tag">Principal</span>}
                  <p>{contact.job_title ?? "Sin cargo registrado"}</p>
                  <small>{contact.phone ?? "Sin teléfono"}{contact.email ? ` · ${contact.email}` : ""}</small>
                </article>
              ))}
            </div>
          ) : <div className="empty-inline">No hay contactos registrados.</div>}

          {canEdit && (
            <form className="inline-form" action={addCustomerContact}>
              <input type="hidden" name="customerId" value={customer.id} />
              <h4>Agregar contacto</h4>
              <div className="form-grid">
                <label>Nombre *<input name="fullName" required maxLength={150} /></label>
                <label>Cargo<input name="jobTitle" maxLength={100} /></label>
                <label>Teléfono<input name="phone" maxLength={40} /></label>
                <label>Correo<input name="email" type="email" maxLength={120} /></label>
              </div>
              <button type="submit">Guardar contacto</button>
            </form>
          )}
        </section>

        <section className="detail-section">
          <div className="section-heading"><h3>Obras y direcciones</h3><span>{sites.length} activas</span></div>
          {sites.length ? (
            <div className="record-list">
              {sites.map((site) => (
                <article key={site.id}>
                  <strong>{site.name}</strong>
                  <p>{site.address}</p>
                  <small>{[site.municipality, site.department].filter(Boolean).join(", ") || "Ubicación sin detalle"}</small>
                  {site.delivery_notes && <small className="delivery-note">Nota: {site.delivery_notes}</small>}
                  {site.latitude !== null && site.longitude !== null && (
                    <div className="map-reference">
                      <iframe title={`Mapa de ${site.name}`} src={openStreetMapEmbed(site.latitude, site.longitude)} loading="lazy" />
                      <a href={googleMapsLink(site.latitude, site.longitude)} target="_blank" rel="noreferrer">Abrir y compartir ubicación exacta</a>
                      <small>{Number(site.latitude).toFixed(6)}, {Number(site.longitude).toFixed(6)}</small>
                    </div>
                  )}
                </article>
              ))}
            </div>
          ) : <div className="empty-inline">No hay obras o direcciones de entrega registradas.</div>}

          {canEdit && (
            <DeliverySiteForm customerId={customer.id} action={addDeliverySite} />
          )}
        </section>
      </div>

      <section className="history-section">
        <div className="section-heading"><h3>Historial comercial</h3><span>Últimos 10 documentos de cada tipo</span></div>
        <div className="history-grid">
          <article className="history-card">
            <h4>Cotizaciones</h4>
            {quotes.length ? (
              <div className="history-table-wrap"><table className="history-table"><thead><tr><th>Número</th><th>Vendedor</th><th>Emisión</th><th>Descuento máx.</th><th>Estado</th><th>Total</th></tr></thead><tbody>
                {quotes.map((quote) => <tr key={quote.id}><td><strong>{quote.quote_number}</strong></td><td>{sellers.get(quote.seller_id) ?? "Vendedor no disponible"}</td><td>{displayDate(quote.issue_date)}</td><td>{Number(quote.authorized_discount_percentage)}%</td><td>{quoteStatus[quote.status] ?? quote.status}</td><td>{money.format(Number(quote.total))}</td></tr>)}
              </tbody></table></div>
            ) : <div className="empty-inline">No hay cotizaciones para este cliente.</div>}
          </article>
          <article className="history-card">
            <h4>Pedidos</h4>
            {orders.length ? (
              <div className="history-table-wrap"><table className="history-table"><thead><tr><th>Número</th><th>Fecha solicitada</th><th>Estado</th><th>Total</th></tr></thead><tbody>
                {orders.map((order) => <tr key={order.id}><td><strong>{order.order_number}</strong></td><td>{displayDate(order.requested_delivery_date)}</td><td>{orderStatus[order.status] ?? order.status}</td><td>{money.format(Number(order.total))}</td></tr>)}
              </tbody></table></div>
            ) : <div className="empty-inline">No hay pedidos para este cliente.</div>}
          </article>
        </div>
      </section>
    </div>
  );
}
