import Link from "next/link";

import { PrintButton } from "@/app/panel/cotizaciones/print-button";
import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

import { registerPayment } from "../actions";

type Invoice = {
  id: string;
  invoice_number: string;
  customer_id: string;
  sales_order_id: string | null;
  delivery_group_id: string | null;
  status: string;
  issue_date: string | null;
  due_date: string | null;
  currency: string;
  subtotal: number | string;
  tax_amount: number | string;
  total: number | string;
};
type Customer = { id: string; legal_name: string; nit: string | null };
type Order = { id: string; order_number: string; payment_terms: string };
type DeliveryGroup = { id: string; delivery_number: string; delivery_date: string };
type InvoiceItem = { id: string; description: string; quantity: number | string; unit_price: number | string; tax_amount: number | string; line_total: number | string };
type Payment = { id: string; payment_date: string; method: string; amount: number | string; reference: string | null; notes: string | null };

const money = new Intl.NumberFormat("es-GT", { style: "currency", currency: "GTQ" });
const date = new Intl.DateTimeFormat("es-GT", { dateStyle: "medium", timeZone: "America/Guatemala" });
const invoiceStatus: Record<string, string> = { draft: "Borrador", issued: "Emitida", partially_paid: "Pago parcial", paid: "Pagada", void: "Anulada" };
const paymentMethod: Record<string, string> = { cash: "Efectivo", bank_transfer: "Transferencia", check: "Cheque", card: "Tarjeta", other: "Otro" };

export default async function InvoiceDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const [user, { id }, messages, supabase] = await Promise.all([getCurrentUser(), params, searchParams, createClient()]);
  const allowed = hasAnyRole(user.roles, ["accounting", "admin", "manager"]);
  if (!allowed) return <div className="module-page"><section className="module-header"><div><p className="eyebrow">CONTABILIDAD</p><h3>Factura</h3><p>No tienes permiso para consultar facturas.</p></div></section></div>;

  const invoiceResult = await supabase.from("invoices").select("id, invoice_number, customer_id, sales_order_id, delivery_group_id, status, issue_date, due_date, currency, subtotal, tax_amount, total").eq("id", id).maybeSingle();
  const invoice = invoiceResult.data as Invoice | null;
  if (!invoice) return <div className="module-page narrow-page"><section className="module-header compact"><div><p className="eyebrow">CONTABILIDAD · FACTURAS</p><h3>No fue posible abrir la factura</h3><p>{invoiceResult.error?.message ?? "No encontramos este documento o no tienes acceso a él."}</p></div></section><Link className="button-link" href="/panel/finanzas">Volver a Finanzas</Link></div>;

  const [customerResult, orderResult, deliveryGroupResult, itemsResult, paymentsResult] = await Promise.all([
    supabase.from("customers").select("id, legal_name, nit").eq("id", invoice.customer_id).maybeSingle(),
    invoice.sales_order_id ? supabase.from("sales_orders").select("id, order_number, payment_terms").eq("id", invoice.sales_order_id).maybeSingle() : Promise.resolve({ data: null }),
    invoice.delivery_group_id ? supabase.from("delivery_groups").select("id, delivery_number, delivery_date").eq("id", invoice.delivery_group_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("invoice_items").select("id, description, quantity, unit_price, tax_amount, line_total").eq("invoice_id", invoice.id).order("id"),
    supabase.from("payments").select("id, payment_date, method, amount, reference, notes").eq("invoice_id", invoice.id).order("payment_date", { ascending: false }).order("id", { ascending: false }),
  ]);
  const customer = customerResult.data as Customer | null;
  const order = orderResult.data as Order | null;
  const deliveryGroup = deliveryGroupResult.data as DeliveryGroup | null;
  const items = (itemsResult.data ?? []) as InvoiceItem[];
  const payments = (paymentsResult.data ?? []) as Payment[];
  const paid = payments.reduce((total, payment) => total + Number(payment.amount), 0);
  const balance = Math.max(0, Number(invoice.total) - paid);
  const canCollect = ["issued", "partially_paid"].includes(invoice.status) && balance > 0;

  return <div className="module-page quote-page">
    <div className="quote-toolbar"><Link className="button-secondary button-link" href="/panel/finanzas">Volver a Finanzas</Link><PrintButton /></div>
    {messages.error && <p className="alert" role="alert">{messages.error}</p>}
    {messages.notice && <p className="notice success" role="status">{messages.notice}</p>}
    <article className="quote-document">
      <header className="quote-document-header"><div className="quote-pattern"><span /><span /><span /></div><div className="quote-wordmark"><strong>LOS CANARIOS</strong><small>PREFABRICADOS DE CONCRETO</small></div></header>
      <section className="quote-document-title"><h1>FACTURA</h1><span>Correlativo No. <strong>{invoice.invoice_number}</strong></span></section>
      <section className="quote-info-grid"><dl><div><dt>Cliente:</dt><dd>{customer?.legal_name ?? "Cliente no disponible"}</dd></div><div><dt>NIT:</dt><dd>{customer?.nit ?? "—"}</dd></div><div><dt>Condiciones de pago:</dt><dd>{order?.payment_terms ?? "—"}</dd></div><div><dt>Estado:</dt><dd>{invoiceStatus[invoice.status] ?? invoice.status}</dd></div></dl><dl><div><dt>Fecha de emisión:</dt><dd>{invoice.issue_date ? date.format(new Date(`${invoice.issue_date}T12:00:00`)) : "—"}</dd></div><div><dt>Vence:</dt><dd>{invoice.due_date ? date.format(new Date(`${invoice.due_date}T12:00:00`)) : "—"}</dd></div>{order && <div><dt>Pedido:</dt><dd>{order.order_number}</dd></div>}{deliveryGroup && <div><dt>Entrega:</dt><dd>{deliveryGroup.delivery_number} · {date.format(new Date(`${deliveryGroup.delivery_date}T12:00:00`))}</dd></div>}</dl></section>
      <table className="quote-document-table"><thead><tr><th>Cant.</th><th>Descripción</th><th>Precio</th><th>Total</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{Number(item.quantity).toFixed(2)}</td><td>{item.description}</td><td>{money.format(Number(item.unit_price))}</td><td>{money.format(Number(item.line_total))}</td></tr>)}</tbody><tfoot><tr><td colSpan={3}>Subtotal</td><td>{money.format(Number(invoice.subtotal))}</td></tr><tr><td colSpan={3}>IVA</td><td>{money.format(Number(invoice.tax_amount))}</td></tr><tr className="document-total"><td colSpan={3}>TOTAL</td><td>{money.format(Number(invoice.total))}</td></tr></tfoot></table>
      <section className="detail-section"><div className="section-heading"><h3>Pagos y saldo</h3><span>Saldo pendiente: {money.format(balance)}</span></div>{payments.length === 0 ? <div className="empty-inline">No hay cobros registrados para esta factura.</div> : <div className="table-card"><table><thead><tr><th>Fecha</th><th>Método</th><th>Referencia</th><th>Notas</th><th>Monto</th></tr></thead><tbody>{payments.map((payment) => <tr key={payment.id}><td>{date.format(new Date(`${payment.payment_date}T12:00:00`))}</td><td>{paymentMethod[payment.method] ?? payment.method}</td><td>{payment.reference ?? "—"}</td><td>{payment.notes ?? "—"}</td><td><strong>{money.format(Number(payment.amount))}</strong></td></tr>)}</tbody></table></div>}{canCollect && <form className="payment-form" action={registerPayment}><input type="hidden" name="invoiceId" value={invoice.id} /><input name="amount" type="number" min="0.01" max={balance.toFixed(2)} step="0.01" placeholder="Monto Q" required /><select name="method" defaultValue="cash"><option value="cash">Efectivo</option><option value="bank_transfer">Transferencia</option><option value="check">Cheque</option><option value="card">Tarjeta</option><option value="other">Otro</option></select><input name="reference" maxLength={120} placeholder="Referencia" /><button type="submit">Registrar cobro</button></form>}</section>
    </article>
  </div>;
}
