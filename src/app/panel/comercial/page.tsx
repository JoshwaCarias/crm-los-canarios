import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

import { saveSalesTarget } from "./actions";

type Seller = { id: string; full_name: string; is_active: boolean };
type Target = { seller_id: string; target_month: string; sales_target: number | string; quote_target: number; notes: string | null };
type Order = { seller_id: string; total: number | string; status: string };
type Quote = { seller_id: string; status: string };
type FollowUp = { id: string; customer_id: string; next_follow_up_date: string | null; follow_up_type: string; notes: string };
type Customer = { id: string; legal_name: string };

const money = new Intl.NumberFormat("es-GT", { style: "currency", currency: "GTQ", maximumFractionDigits: 0 });
function guatemalaMonthStart() { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Guatemala", year: "numeric", month: "2-digit" }).formatToParts(new Date()); const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "01"; return `${read("year")}-${read("month")}-01`; }
function percent(value: number, target: number) { return target > 0 ? Math.min(100, value / target * 100) : 0; }

export default async function CommercialPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const [user, messages, supabase] = await Promise.all([getCurrentUser(), searchParams, createClient()]);
  const leadership = hasAnyRole(user.roles, ["admin", "manager"]);
  const canUse = leadership || user.roles.includes("seller");
  if (!canUse) return <div className="module-page"><section className="module-header"><div><p className="eyebrow">VENTAS</p><h3>Control comercial</h3><p>No tienes permiso para este módulo.</p></div></section></div>;
  const monthStart = guatemalaMonthStart();
  const [sellersResult, targetsResult, ordersResult, quotesResult, followUpsResult] = await Promise.all([
    supabase.from("seller_directory").select("id, full_name, is_active").eq("is_active", true).order("full_name"),
    supabase.from("sales_targets").select("seller_id, target_month, sales_target, quote_target, notes").eq("target_month", monthStart),
    supabase.from("sales_orders").select("seller_id, total, status").gte("created_at", monthStart).limit(1000),
    supabase.from("quotes").select("seller_id, status").gte("created_at", monthStart).limit(1000),
    supabase.from("customer_follow_ups").select("id, customer_id, next_follow_up_date, follow_up_type, notes").not("next_follow_up_date", "is", null).order("next_follow_up_date").limit(20),
  ]);
  const sellers = ((sellersResult.data ?? []) as Seller[]).filter((seller) => leadership || seller.id === user.id);
  const targets = (targetsResult.data ?? []) as Target[];
  const orders = (ordersResult.data ?? []) as Order[];
  const quotes = (quotesResult.data ?? []) as Quote[];
  const targetBySeller = new Map(targets.map((target) => [target.seller_id, target]));
  const salesBySeller = new Map<string, number>(); const quotesBySeller = new Map<string, number>();
  const funnelStages = [
    { label: "Pendientes de aprobar", statuses: ["pending_admin_approval", "sent"] },
    { label: "Aprobadas / fabricación", statuses: ["approved", "in_production"] },
    { label: "Autorización de despacho", statuses: ["pending_dispatch_authorization"] },
    { label: "Despacho / ruta", statuses: ["in_dispatch", "in_route"] },
    { label: "Entregadas", statuses: ["delivered"] },
    { label: "Canceladas", statuses: ["cancelled"] },
  ];
  for (const order of orders) if (order.status !== "cancelled") salesBySeller.set(order.seller_id, (salesBySeller.get(order.seller_id) ?? 0) + Number(order.total));
  for (const quote of quotes) if (orderableQuote(quote.status)) quotesBySeller.set(quote.seller_id, (quotesBySeller.get(quote.seller_id) ?? 0) + 1);
  const followUps = (followUpsResult.data ?? []) as FollowUp[];
  const customerIds = [...new Set(followUps.map((followUp) => followUp.customer_id))];
  const customersResult = customerIds.length ? await supabase.from("customers").select("id, legal_name").in("id", customerIds) : { data: [] as Customer[] };
  const customerNames = new Map(((customersResult.data ?? []) as Customer[]).map((customer) => [customer.id, customer.legal_name]));

  return <div className="module-page"><section className="module-header"><div><p className="eyebrow">VENTAS · SEGUIMIENTO</p><h3>Control comercial</h3><p>Metas mensuales, avance de ventas y próximos contactos con clientes.</p></div></section>{messages.error && <p className="alert" role="alert">{messages.error}</p>}{messages.notice && <p className="notice success" role="status">{messages.notice}</p>}
    {leadership && <section className="detail-section"><div className="section-heading"><h3>Definir meta mensual</h3><span>Una nueva meta actualiza la existente para el vendedor y mes.</span></div><form className="inline-form form-grid" action={saveSalesTarget}><label>Vendedor *<select name="sellerId" required><option value="">Selecciona</option>{sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.full_name}</option>)}</select></label><label>Mes *<input name="targetMonth" type="month" defaultValue={monthStart.slice(0, 7)} required /></label><label>Meta de ventas (Q) *<input name="salesTarget" type="number" min="0" step="0.01" required /></label><label>Meta de cotizaciones *<input name="quoteTarget" type="number" min="0" step="1" required /></label><label className="full-width">Notas<textarea name="notes" rows={2} maxLength={1200} /></label><button type="submit">Guardar meta</button></form></section>}
    <section className="detail-section"><div className="section-heading"><h3>Avance de metas</h3><span>Mes actual</span></div>{sellers.length === 0 ? <div className="empty-inline">No hay vendedores activos configurados.</div> : <div className="commercial-grid">{sellers.map((seller) => { const target = targetBySeller.get(seller.id); const sales = salesBySeller.get(seller.id) ?? 0; const quoteCount = quotesBySeller.get(seller.id) ?? 0; const salesTarget = Number(target?.sales_target ?? 0); const quoteTarget = Number(target?.quote_target ?? 0); return <article key={seller.id}><h4>{seller.full_name}</h4><div><span>Ventas</span><strong>{money.format(sales)}</strong><small>{salesTarget > 0 ? `Meta: ${money.format(salesTarget)}` : "Sin meta asignada"}</small><i><b style={{ width: `${percent(sales, salesTarget)}%` }} /></i></div><div><span>Cotizaciones</span><strong>{quoteCount}</strong><small>{quoteTarget > 0 ? `Meta: ${quoteTarget}` : "Sin meta asignada"}</small><i><b style={{ width: `${percent(quoteCount, quoteTarget)}%` }} /></i></div></article>; })}</div>}</section>
    <section className="detail-section"><div className="section-heading"><h3>Embudo comercial</h3><span>Cotizaciones creadas este mes</span></div><div className="pipeline-grid">{funnelStages.map((stage) => <article key={stage.label}><span>{stage.label}</span><strong>{quotes.filter((quote) => stage.statuses.includes(quote.status)).length}</strong></article>)}</div><p className="form-help">Las cancelaciones conservan su motivo en la bitácora de cada cotización.</p></section>
    <section className="detail-section"><div className="section-heading"><h3>Próximos seguimientos</h3><Link className="text-link" href="/panel/clientes">Ver clientes</Link></div>{followUps.length === 0 ? <div className="empty-inline">No hay seguimientos programados.</div> : <div className="follow-up-list">{followUps.map((followUp) => <article key={followUp.id}><div><strong>{customerNames.get(followUp.customer_id) ?? "Cliente"}</strong><span className="mini-tag">{followUp.follow_up_type}</span><small>{followUp.next_follow_up_date}</small></div><p>{followUp.notes}</p><Link className="text-link" href={`/panel/clientes/${followUp.customer_id}`}>Registrar seguimiento →</Link></article>)}</div>}</section>
  </div>;
}

function orderableQuote(status: string) { return !["draft", "cancelled", "rejected", "expired"].includes(status); }
