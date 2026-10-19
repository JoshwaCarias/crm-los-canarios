import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

import { createInvoice, registerPayment } from "./actions";

type DeliveryGroup = { id: string; delivery_number: string; sales_order_id: string; delivery_date: string; status: string };
type Shipment = { id: string; delivery_group_id: string | null; shipment_number: string; freight_charge: number | string };
type ShipmentItem = { shipment_id: string; sales_order_item_id: string; loaded_quantity: number | string; delivered_quantity: number | string | null };
type OrderItem = { id: string; ordered_quantity: number | string; line_total: number | string };
type Order = { id: string; order_number: string; customer_id: string; payment_terms: string };
type Invoice = { id: string; invoice_number: string; customer_id: string; sales_order_id: string | null; status: string; issue_date: string | null; due_date: string | null; total: number | string; created_at: string };
type Payment = { invoice_id: string | null; amount: number | string };
type Customer = { id: string; legal_name: string; credit_limit: number | string; credit_used: number | string };

const money = new Intl.NumberFormat("es-GT", { style: "currency", currency: "GTQ" });
const date = new Intl.DateTimeFormat("es-GT", { dateStyle: "medium", timeZone: "America/Guatemala" });
const invoiceStatus: Record<string, string> = { draft: "Borrador", issued: "Emitida", partially_paid: "Pago parcial", paid: "Pagada", void: "Anulada" };

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const [user, messages, supabase] = await Promise.all([getCurrentUser(), searchParams, createClient()]);
  const allowed = hasAnyRole(user.roles, ["accounting", "admin", "manager"]);
  if (!allowed) return <div className="module-page"><section className="module-header"><div><p className="eyebrow">CONTABILIDAD</p><h3>Finanzas</h3><p>No tienes permiso para este módulo.</p></div></section></div>;

  const [deliveryGroupsResult, invoicesResult, customersResult] = await Promise.all([
    supabase.from("delivery_groups").select("id, delivery_number, sales_order_id, delivery_date, status").eq("status", "delivered").order("delivery_date").limit(100),
    supabase.from("invoices").select("id, invoice_number, customer_id, sales_order_id, status, issue_date, due_date, total, created_at").in("status", ["issued", "partially_paid", "paid", "void"]).order("created_at", { ascending: false }).limit(100),
    supabase.from("customers").select("id, legal_name, credit_limit, credit_used").order("legal_name").limit(100),
  ]);
  const deliveryGroups = (deliveryGroupsResult.data ?? []) as DeliveryGroup[];
  const invoices = (invoicesResult.data ?? []) as Invoice[];
  const invoicesForCollection = invoices.filter((invoice) => ["issued", "partially_paid"].includes(invoice.status));
  const customers = (customersResult.data ?? []) as Customer[];
  const deliveryGroupIds = deliveryGroups.map((group) => group.id);
  const orderIds = [...new Set(deliveryGroups.map((group) => group.sales_order_id))];
  const [shipmentsResult, ordersResult] = await Promise.all([
    deliveryGroupIds.length ? supabase.from("shipments").select("id, delivery_group_id, shipment_number, freight_charge").in("delivery_group_id", deliveryGroupIds).eq("status", "delivered") : Promise.resolve({ data: [] as Shipment[] }),
    orderIds.length ? supabase.from("sales_orders").select("id, order_number, customer_id, payment_terms").in("id", orderIds) : Promise.resolve({ data: [] as Order[] }),
  ]);
  const shipments = (shipmentsResult.data ?? []) as Shipment[];
  const shipmentIds = shipments.map((shipment) => shipment.id);
  const shipmentItemsResult = shipmentIds.length ? await supabase.from("shipment_items").select("shipment_id, sales_order_item_id, loaded_quantity, delivered_quantity").in("shipment_id", shipmentIds) : { data: [] as ShipmentItem[] };
  const shipmentItems = (shipmentItemsResult.data ?? []) as ShipmentItem[];
  const orderItemIds = [...new Set(shipmentItems.map((item) => item.sales_order_item_id))];
  const orderItemsResult = orderItemIds.length ? await supabase.from("sales_order_items").select("id, ordered_quantity, line_total").in("id", orderItemIds) : { data: [] as OrderItem[] };
  const orderItems = (orderItemsResult.data ?? []) as OrderItem[];
  const invoiceIds = invoices.map((invoice) => invoice.id);
  const paymentsResult = invoiceIds.length ? await supabase.from("payments").select("invoice_id, amount").in("invoice_id", invoiceIds) : { data: [] as Payment[] };

  const orders = (ordersResult.data ?? []) as Order[];
  const paidByInvoice = new Map<string, number>();
  for (const payment of (paymentsResult.data ?? []) as Payment[]) if (payment.invoice_id) paidByInvoice.set(payment.invoice_id, (paidByInvoice.get(payment.invoice_id) ?? 0) + Number(payment.amount));
  const customerNames = new Map(customers.map((customer) => [customer.id, customer.legal_name]));
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const itemById = new Map(orderItems.map((item) => [item.id, item]));
  const shipmentsByGroup = new Map<string, Shipment[]>();
  for (const shipment of shipments) if (shipment.delivery_group_id) shipmentsByGroup.set(shipment.delivery_group_id, [...(shipmentsByGroup.get(shipment.delivery_group_id) ?? []), shipment]);
  const itemsByShipment = new Map<string, ShipmentItem[]>();
  for (const shipmentItem of shipmentItems) itemsByShipment.set(shipmentItem.shipment_id, [...(itemsByShipment.get(shipmentItem.shipment_id) ?? []), shipmentItem]);
  const invoiceTotalForGroup = (group: DeliveryGroup) => (shipmentsByGroup.get(group.id) ?? []).reduce((total, shipment) => {
    const productTotal = (itemsByShipment.get(shipment.id) ?? []).reduce((subtotal, shipmentItem) => {
      const orderItem = itemById.get(shipmentItem.sales_order_item_id);
      if (!orderItem) return subtotal;
      return subtotal + Number(orderItem.line_total) * Number(shipmentItem.delivered_quantity ?? shipmentItem.loaded_quantity) / Number(orderItem.ordered_quantity);
    }, 0);
    return total + productTotal + Number(shipment.freight_charge);
  }, 0);

  return <div className="module-page"><section className="module-header"><div><p className="eyebrow">CONTABILIDAD · CRÉDITO Y COBROS</p><h3>Finanzas</h3><p>Factura cada entrega parcial confirmada, agrupando todos los fletes del mismo pedido y día.</p></div></section>{messages.error && <p className="alert" role="alert">{messages.error}</p>}{messages.notice && <p className="notice success" role="status">{messages.notice}</p>}
    <section className="detail-section"><div className="section-heading"><h3>Entregas confirmadas por facturar</h3><span>{deliveryGroups.length} entregas diarias pendientes</span></div>{deliveryGroups.length === 0 ? <div className="empty-inline">No hay entregas completas pendientes de facturación.</div> : <div className="table-card"><table><thead><tr><th>Entrega</th><th>Pedido</th><th>Cliente</th><th>Fecha</th><th>Fletes</th><th>Total a facturar</th><th /></tr></thead><tbody>{deliveryGroups.map((group) => { const order = orderById.get(group.sales_order_id); const groupShipments = shipmentsByGroup.get(group.id) ?? []; return <tr key={group.id}><td><strong>{group.delivery_number}</strong></td><td>{order?.order_number ?? "—"}</td><td>{order ? customerNames.get(order.customer_id) ?? "—" : "—"}</td><td>{date.format(new Date(`${group.delivery_date}T12:00:00`))}</td><td>{groupShipments.map((shipment) => shipment.shipment_number).join(", ") || "—"}<small>{money.format(groupShipments.reduce((sum, shipment) => sum + Number(shipment.freight_charge), 0))}</small></td><td><strong>{money.format(invoiceTotalForGroup(group))}</strong></td><td><form action={createInvoice}><input type="hidden" name="deliveryGroupId" value={group.id} /><button className="button-secondary" type="submit">Generar factura</button></form></td></tr>; })}</tbody></table></div>}</section>
    <section className="detail-section"><div className="section-heading"><h3>Facturas por cobrar</h3><span>El saldo se recalcula con cada pago.</span></div>{invoicesForCollection.length === 0 ? <div className="empty-inline">No hay facturas pendientes de cobro.</div> : <div className="table-card"><table><thead><tr><th>Factura</th><th>Cliente</th><th>Vence</th><th>Total</th><th>Saldo</th><th>Estado</th><th>Registrar pago</th></tr></thead><tbody>{invoicesForCollection.map((invoice) => { const paid = paidByInvoice.get(invoice.id) ?? 0; const balance = Number(invoice.total) - paid; return <tr key={invoice.id}><td><strong>{invoice.invoice_number}</strong><small>Emisión: {invoice.issue_date ? date.format(new Date(`${invoice.issue_date}T12:00:00`)) : "—"}</small><Link className="text-link" href={`/panel/finanzas/${invoice.id}`}>Ver factura</Link></td><td>{customerNames.get(invoice.customer_id) ?? "—"}</td><td>{invoice.due_date ? date.format(new Date(`${invoice.due_date}T12:00:00`)) : "—"}</td><td>{money.format(Number(invoice.total))}</td><td><strong>{money.format(balance)}</strong></td><td><span className="status-pill active">{invoiceStatus[invoice.status] ?? invoice.status}</span></td><td><form className="payment-form" action={registerPayment}><input type="hidden" name="invoiceId" value={invoice.id} /><input name="amount" type="number" min="0.01" max={balance.toFixed(2)} step="0.01" placeholder="Monto Q" required /><select name="method" defaultValue="cash"><option value="cash">Efectivo</option><option value="bank_transfer">Transferencia</option><option value="check">Cheque</option><option value="card">Tarjeta</option><option value="other">Otro</option></select><input name="reference" maxLength={120} placeholder="Referencia" /><button type="submit">Cobrar</button></form></td></tr>; })}</tbody></table></div>}</section>
    <section className="detail-section"><div className="section-heading"><h3>Historial de facturas</h3><span>Incluye emitidas, pagadas y anuladas.</span></div>{invoices.length === 0 ? <div className="empty-inline">Aún no se han emitido facturas.</div> : <div className="table-card"><table><thead><tr><th>Factura</th><th>Cliente</th><th>Emisión</th><th>Total</th><th>Cobrado</th><th>Estado</th><th /></tr></thead><tbody>{invoices.map((invoice) => { const paid = paidByInvoice.get(invoice.id) ?? 0; return <tr key={invoice.id}><td><strong>{invoice.invoice_number}</strong></td><td>{customerNames.get(invoice.customer_id) ?? "—"}</td><td>{invoice.issue_date ? date.format(new Date(`${invoice.issue_date}T12:00:00`)) : "—"}</td><td>{money.format(Number(invoice.total))}</td><td>{money.format(paid)}</td><td><span className={`status-pill ${invoice.status === "paid" ? "active" : ""}`}>{invoiceStatus[invoice.status] ?? invoice.status}</span></td><td><Link className="button-secondary button-link" href={`/panel/finanzas/${invoice.id}`}>Ver factura</Link></td></tr>; })}</tbody></table></div>}</section>
    <section className="detail-section"><div className="section-heading"><h3>Crédito de clientes</h3><span>El disponible considera pedidos a crédito y fletes reales facturados.</span></div><div className="table-card"><table><thead><tr><th>Cliente</th><th>Límite</th><th>Usado / reservado</th><th>Disponible</th></tr></thead><tbody>{customers.filter((customer) => Number(customer.credit_limit) > 0 || Number(customer.credit_used) > 0).map((customer) => <tr key={customer.id}><td>{customer.legal_name}</td><td>{money.format(Number(customer.credit_limit))}</td><td>{money.format(Number(customer.credit_used))}</td><td><strong>{money.format(Math.max(0, Number(customer.credit_limit) - Number(customer.credit_used)))}</strong></td></tr>)}</tbody></table></div></section>
  </div>;
}
