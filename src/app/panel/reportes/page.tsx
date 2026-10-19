import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

type Quote = { status: string; total: number | string; created_at: string };
type Order = { id: string; seller_id: string; status: string; total: number | string; freight_amount: number | string; created_at: string };
type Invoice = { id: string; status: string; total: number | string; created_at: string };
type Payment = { invoice_id: string | null; amount: number | string };
type Shipment = { freight_cost: number | string; freight_charge: number | string; scheduled_at: string };
type Profile = { id: string; full_name: string };
type OrderItem = { sales_order_id: string; product_id: string; ordered_quantity: number | string; line_total: number | string };
type Product = { id: string; sku: string; name: string };

const money = new Intl.NumberFormat("es-GT", { style: "currency", currency: "GTQ", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("es-GT", { maximumFractionDigits: 0 });
const monthName = new Intl.DateTimeFormat("es-GT", { month: "long", year: "numeric", timeZone: "America/Guatemala" });
const quoteLabels: Record<string, string> = { pending_admin_approval: "Por aprobar", approved: "Aprobadas", in_production: "Fabricación", pending_dispatch_authorization: "Aut. despacho", in_dispatch: "Despacho", in_route: "En ruta", delivered: "Entregadas", cancelled: "Canceladas" };

function startsCurrentMonth(date: Date) {
  const local = new Date(date.toLocaleString("en-US", { timeZone: "America/Guatemala" }));
  return new Date(local.getFullYear(), local.getMonth(), 1).toISOString();
}
function sum<T>(rows: T[], pick: (row: T) => number) { return rows.reduce((total, row) => total + pick(row), 0); }

export default async function ReportsPage() {
  const [user, supabase] = await Promise.all([getCurrentUser(), createClient()]);
  const allowed = hasAnyRole(user.roles, ["admin", "manager"]);
  if (!allowed) return <div className="module-page"><section className="module-header"><div><p className="eyebrow">GERENCIA</p><h3>Reportes</h3><p>Este tablero está disponible para Administración y Gerencia.</p></div></section></div>;

  const monthStart = startsCurrentMonth(new Date());
  const [quotesResult, ordersResult, invoicesResult, shipmentsResult, profilesResult] = await Promise.all([
    supabase.from("quotes").select("status, total, created_at").gte("created_at", monthStart).limit(1000),
    supabase.from("sales_orders").select("id, seller_id, status, total, freight_amount, created_at").gte("created_at", monthStart).limit(1000),
    supabase.from("invoices").select("id, status, total, created_at").limit(1000),
    supabase.from("shipments").select("freight_cost, freight_charge, scheduled_at").gte("scheduled_at", monthStart).limit(1000),
    supabase.from("profiles").select("id, full_name").eq("is_active", true),
  ]);
  const quotes = (quotesResult.data ?? []) as Quote[];
  const orders = (ordersResult.data ?? []) as Order[];
  const invoices = (invoicesResult.data ?? []) as Invoice[];
  const shipments = (shipmentsResult.data ?? []) as Shipment[];
  const profiles = (profilesResult.data ?? []) as Profile[];
  const invoiceIds = invoices.map((invoice) => invoice.id);
  const paymentsResult = invoiceIds.length ? await supabase.from("payments").select("invoice_id, amount").in("invoice_id", invoiceIds) : { data: [] as Payment[] };
  const paidByInvoice = new Map<string, number>();
  for (const payment of (paymentsResult.data ?? []) as Payment[]) if (payment.invoice_id) paidByInvoice.set(payment.invoice_id, (paidByInvoice.get(payment.invoice_id) ?? 0) + Number(payment.amount));
  const monthOrders = orders.filter((order) => order.status !== "cancelled");
  const salesAmount = sum(monthOrders, (order) => Number(order.total));
  const freightCharged = sum(shipments, (shipment) => Number(shipment.freight_charge));
  const freightCost = sum(shipments, (shipment) => Number(shipment.freight_cost));
  const outstanding = sum(invoices.filter((invoice) => ["issued", "partially_paid"].includes(invoice.status)), (invoice) => Number(invoice.total) - (paidByInvoice.get(invoice.id) ?? 0));
  const ordersInProcess = orders.filter((order) => ["pending_fulfillment", "ready_for_dispatch"].includes(order.status)).length;
  const quoteCounts = new Map<string, number>();
  for (const quote of quotes) quoteCounts.set(quote.status, (quoteCounts.get(quote.status) ?? 0) + 1);
  const sellerNames = new Map(profiles.map((profile) => [profile.id, profile.full_name]));
  const sellerTotals = new Map<string, { amount: number; orders: number }>();
  for (const order of monthOrders) {
    const current = sellerTotals.get(order.seller_id) ?? { amount: 0, orders: 0 };
    sellerTotals.set(order.seller_id, { amount: current.amount + Number(order.total), orders: current.orders + 1 });
  }
  const rankedSellers = [...sellerTotals.entries()].map(([sellerId, result]) => ({ sellerId, ...result })).sort((left, right) => right.amount - left.amount).slice(0, 8);
  const orderIds = monthOrders.map((order) => order.id);
  const orderItemsResult = orderIds.length ? await supabase.from("sales_order_items").select("sales_order_id, product_id, ordered_quantity, line_total").in("sales_order_id", orderIds) : { data: [] as OrderItem[] };
  const orderItems = (orderItemsResult.data ?? []) as OrderItem[];
  const productIds = [...new Set(orderItems.map((item) => item.product_id))];
  const productsResult = productIds.length ? await supabase.from("products").select("id, sku, name").in("id", productIds) : { data: [] as Product[] };
  const productNames = new Map(((productsResult.data ?? []) as Product[]).map((product) => [product.id, `${product.sku} · ${product.name}`]));
  const productTotals = new Map<string, { amount: number; quantity: number }>();
  for (const item of orderItems) {
    const current = productTotals.get(item.product_id) ?? { amount: 0, quantity: 0 };
    productTotals.set(item.product_id, { amount: current.amount + Number(item.line_total), quantity: current.quantity + Number(item.ordered_quantity) });
  }
  const rankedProducts = [...productTotals.entries()].map(([productId, result]) => ({ productId, ...result })).sort((left, right) => right.amount - left.amount).slice(0, 8);
  const maxSellerAmount = Math.max(1, ...rankedSellers.map((seller) => seller.amount));

  return <div className="module-page"><section className="module-header"><div><p className="eyebrow">GERENCIA · INDICADORES</p><h3>Reporte de {monthName.format(new Date())}</h3><p>Los montos de venta y crédito incluyen los fletes registrados en los pedidos.</p></div></section>
    <section className="metric-grid report-metrics"><article className="metric-card"><span>Ventas del mes</span><strong>{money.format(salesAmount)}</strong><p>{number.format(monthOrders.length)} pedidos no cancelados.</p></article><article className="metric-card"><span>Pedidos en proceso</span><strong>{number.format(ordersInProcess)}</strong><p>En fabricación o autorizados para despacho.</p></article><article className="metric-card"><span>Cuentas por cobrar</span><strong>{money.format(outstanding)}</strong><p>Facturas emitidas con saldo pendiente.</p></article><article className="metric-card"><span>Margen de flete</span><strong>{money.format(freightCharged - freightCost)}</strong><p>Cobrado: {money.format(freightCharged)} · Costo: {money.format(freightCost)}</p></article></section>
    <section className="detail-section"><div className="section-heading"><h3>Embudo operativo de cotizaciones</h3><span>Documentos creados este mes</span></div><div className="pipeline-grid">{Object.entries(quoteLabels).filter(([status]) => (quoteCounts.get(status) ?? 0) > 0).map(([status, label]) => <article key={status}><span>{label}</span><strong>{number.format(quoteCounts.get(status) ?? 0)}</strong></article>)}{quotes.length === 0 && <div className="empty-inline">No hay cotizaciones registradas este mes.</div>}</div></section>
    <section className="detail-grid"><section className="detail-section"><div className="section-heading"><h3>Ventas por vendedor</h3><span>Pedidos del mes</span></div>{rankedSellers.length === 0 ? <div className="empty-inline">Aún no hay pedidos este mes.</div> : <div className="report-ranking">{rankedSellers.map((seller) => <article key={seller.sellerId}><div><strong>{sellerNames.get(seller.sellerId) ?? "Vendedor no disponible"}</strong><small>{seller.orders} pedidos · {money.format(seller.amount)}</small></div><span><i style={{ width: `${Math.max(5, seller.amount / maxSellerAmount * 100)}%` }} /></span></article>)}</div>}</section>
      <section className="detail-section"><div className="section-heading"><h3>Productos con mayor venta</h3><span>Valor neto, sin flete</span></div>{rankedProducts.length === 0 ? <div className="empty-inline">Aún no hay productos vendidos este mes.</div> : <div className="report-ranking">{rankedProducts.map((product) => <article key={product.productId}><div><strong>{productNames.get(product.productId) ?? "Producto no disponible"}</strong><small>{number.format(product.quantity)} unidades · {money.format(product.amount)}</small></div></article>)}</div>}</section></section>
  </div>;
}
