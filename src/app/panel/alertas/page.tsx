import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

type Quote = { id: string; quote_number: string; status: string; valid_until: string | null; customer_id: string };
type FollowUp = { id: string; customer_id: string; next_follow_up_date: string | null; follow_up_type: string; notes: string };
type Order = { id: string; order_number: string; status: string; created_at: string; quote_id: string | null };
type Shipment = { id: string; shipment_number: string; status: string; scheduled_at: string };
type Incident = { id: string; shipment_id: string; incident_type: string; description: string; status: string; occurred_at: string };
type Invoice = { id: string; invoice_number: string; status: string; due_date: string | null; customer_id: string };
type Customer = { id: string; legal_name: string; credit_limit: number | string; credit_used: number | string };

type AlertItem = { id: string; severity: "urgent" | "warning" | "info"; title: string; description: string; area: string; href: string };

function todayInGuatemala() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Guatemala" }).format(new Date()); }
function addDays(date: string, days: number) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function ageInDays(value: string, today: string) { return Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(value)) / 86_400_000); }

export default async function AlertsPage() {
  const user = await getCurrentUser();
  if (!hasAnyRole(user.roles, ["dispatch", "plant", "accounting", "admin", "manager"])) return <div className="module-page"><section className="module-header"><div><p className="eyebrow">OPERACIÓN</p><h3>Alertas</h3><p>No tienes permiso para este módulo.</p></div></section></div>;
  const supabase = await createClient();
  const today = todayInGuatemala();
  const nextTwoDays = addDays(today, 2);
  const [quotesResult, followUpsResult, ordersResult, shipmentsResult, invoicesResult, customersResult, incidentsResult] = await Promise.all([
    supabase.from("quotes").select("id, quote_number, status, valid_until, customer_id").in("status", ["pending_admin_approval", "approved", "in_production", "pending_dispatch_authorization"]).not("valid_until", "is", null).lte("valid_until", nextTwoDays).limit(100),
    supabase.from("customer_follow_ups").select("id, customer_id, next_follow_up_date, follow_up_type, notes").not("next_follow_up_date", "is", null).lte("next_follow_up_date", today).order("next_follow_up_date").limit(100),
    supabase.from("sales_orders").select("id, order_number, status, created_at, quote_id").in("status", ["pending_fulfillment", "ready_for_dispatch"]).order("created_at").limit(100),
    supabase.from("shipments").select("id, shipment_number, status, scheduled_at").in("status", ["planned", "loaded", "in_transit"]).lte("scheduled_at", `${today}T23:59:59-06:00`).order("scheduled_at").limit(100),
    supabase.from("invoices").select("id, invoice_number, status, due_date, customer_id").in("status", ["issued", "partially_paid"]).not("due_date", "is", null).lte("due_date", today).order("due_date").limit(100),
    supabase.from("customers").select("id, legal_name, credit_limit, credit_used").limit(1000),
    supabase.from("incidents").select("id, shipment_id, incident_type, description, status, occurred_at").in("status", ["open", "in_progress"]).order("occurred_at", { ascending: false }).limit(100),
  ]);
  const quotes = (quotesResult.data ?? []) as Quote[];
  const followUps = (followUpsResult.data ?? []) as FollowUp[];
  const orders = (ordersResult.data ?? []) as Order[];
  const shipments = (shipmentsResult.data ?? []) as Shipment[];
  const invoices = (invoicesResult.data ?? []) as Invoice[];
  const customers = (customersResult.data ?? []) as Customer[];
  const incidents = (incidentsResult.data ?? []) as Incident[];
  const customerNames = new Map(customers.map((customer) => [customer.id, customer.legal_name]));
  const alerts: AlertItem[] = [];
  for (const quote of quotes) {
    const expired = quote.valid_until! < today;
    alerts.push({ id: `quote-${quote.id}`, severity: expired ? "urgent" : "warning", area: "Cotizaciones", title: `${quote.quote_number} ${expired ? "venció" : "vence pronto"}`, description: `${customerNames.get(quote.customer_id) ?? "Cliente"} · Vigencia: ${quote.valid_until}`, href: `/panel/cotizaciones/${quote.id}` });
  }
  for (const followUp of followUps) alerts.push({ id: `followup-${followUp.id}`, severity: followUp.next_follow_up_date! < today ? "urgent" : "warning", area: "Seguimiento", title: `Seguimiento ${followUp.follow_up_type} pendiente`, description: `${customerNames.get(followUp.customer_id) ?? "Cliente"} · ${followUp.notes.slice(0, 110)}`, href: `/panel/clientes/${followUp.customer_id}` });
  for (const order of orders) {
    const age = ageInDays(order.created_at, today);
    if (age >= 3) alerts.push({ id: `order-${order.id}`, severity: age >= 7 ? "urgent" : "warning", area: "Operación", title: `${order.order_number} lleva ${age} días en ${order.status === "pending_fulfillment" ? "fabricación" : "despacho"}`, description: "Revisa la cotización vinculada y programa la siguiente acción.", href: order.quote_id ? `/panel/cotizaciones/${order.quote_id}` : "/panel/pedidos" });
  }
  for (const shipment of shipments) {
    const shipmentDay = shipment.scheduled_at.slice(0, 10);
    const late = shipmentDay < today;
    alerts.push({ id: `shipment-${shipment.id}`, severity: late ? "urgent" : "info", area: "Despachos", title: `${shipment.shipment_number} ${late ? "está atrasado" : "está programado para hoy"}`, description: `Estado actual: ${shipment.status}`, href: "/panel/despachos" });
  }
  for (const incident of incidents) {
    alerts.push({ id: `incident-${incident.id}`, severity: incident.status === "open" ? "urgent" : "warning", area: "Incidencias", title: `Incidencia abierta en despacho`, description: `${incident.incident_type} · ${incident.description.slice(0, 110)}`, href: "/panel/despachos" });
  }
  for (const invoice of invoices) {
    const late = invoice.due_date! < today;
    alerts.push({ id: `invoice-${invoice.id}`, severity: late ? "urgent" : "warning", area: "Cobros", title: `${invoice.invoice_number} ${late ? "está vencida" : "vence hoy"}`, description: `Cliente: ${customerNames.get(invoice.customer_id) ?? "Cliente"}`, href: "/panel/finanzas" });
  }
  for (const customer of customers) {
    const limit = Number(customer.credit_limit); const used = Number(customer.credit_used);
    if (limit > 0 && used >= limit) alerts.push({ id: `credit-${customer.id}`, severity: "urgent", area: "Crédito", title: `${customer.legal_name} agotó su crédito`, description: `Cupo utilizado: Q ${used.toLocaleString("es-GT")} de Q ${limit.toLocaleString("es-GT")}.`, href: "/panel/finanzas" });
    else if (limit > 0 && used / limit >= .85) alerts.push({ id: `credit-warning-${customer.id}`, severity: "warning", area: "Crédito", title: `${customer.legal_name} supera el 85% de crédito`, description: `Cupo utilizado: Q ${used.toLocaleString("es-GT")} de Q ${limit.toLocaleString("es-GT")}.`, href: "/panel/finanzas" });
  }
  const priority = { urgent: 0, warning: 1, info: 2 };
  alerts.sort((left, right) => priority[left.severity] - priority[right.severity]);
  const counts = { urgent: alerts.filter((alert) => alert.severity === "urgent").length, warning: alerts.filter((alert) => alert.severity === "warning").length, info: alerts.filter((alert) => alert.severity === "info").length };

  return <div className="module-page"><section className="module-header"><div><p className="eyebrow">CONTROL OPERATIVO</p><h3>Alertas</h3><p>Prioriza los asuntos que requieren acción hoy. Las alertas se calculan con información actual de CRM.</p></div></section><section className="alert-summary"><article className="alert-summary-urgent"><span>Urgentes</span><strong>{counts.urgent}</strong></article><article><span>Por atender</span><strong>{counts.warning}</strong></article><article><span>Informativas</span><strong>{counts.info}</strong></article></section>{alerts.length === 0 ? <div className="empty-card">No hay alertas activas. La operación está al día.</div> : <div className="alert-list">{alerts.map((alert) => <Link className={`alert-card ${alert.severity}`} href={alert.href} key={alert.id}><span>{alert.area}</span><strong>{alert.title}</strong><p>{alert.description}</p><small>Ver y atender →</small></Link>)}</div>}</div>;
}
