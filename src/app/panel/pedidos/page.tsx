import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

type Order = {
  id: string;
  order_number: string;
  quote_id: string | null;
  customer_id: string;
  seller_id: string;
  status: string;
  payment_terms: string;
  total: number | string;
  freight_amount: number | string;
  credit_reserved_amount: number | string;
  created_at: string;
};
type Customer = { id: string; legal_name: string };

const money = new Intl.NumberFormat("es-GT", { style: "currency", currency: "GTQ" });
const date = new Intl.DateTimeFormat("es-GT", { dateStyle: "medium", timeZone: "America/Guatemala" });
const statusLabel: Record<string, string> = {
  draft: "Borrador", pending_approval: "Pendiente", approved: "Aprobado", pending_fulfillment: "En fabricación",
  ready_for_dispatch: "Listo para despacho", partially_delivered: "Entrega parcial", delivered: "Entregado",
  invoiced: "Facturado", closed: "Cerrado", cancelled: "Cancelado",
};

export default async function OrdersPage() {
  const [user, supabase] = await Promise.all([getCurrentUser(), createClient()]);
  const onlySeller = user.roles.includes("seller") && !hasAnyRole(user.roles, ["admin", "manager", "dispatch", "plant", "accounting"]);
  let query = supabase.from("sales_orders").select("id, order_number, quote_id, customer_id, seller_id, status, payment_terms, total, freight_amount, credit_reserved_amount, created_at").order("created_at", { ascending: false }).limit(100);
  if (onlySeller) query = query.eq("seller_id", user.id);
  const { data } = await query;
  const orders = (data ?? []) as Order[];
  const customerIds = [...new Set(orders.map((order) => order.customer_id))];
  const customersResult = customerIds.length ? await supabase.from("customers").select("id, legal_name").in("id", customerIds) : { data: [] as Customer[] };
  const customerNames = new Map(((customersResult.data ?? []) as Customer[]).map((customer) => [customer.id, customer.legal_name]));

  return (
    <div className="module-page">
      <section className="module-header"><div><p className="eyebrow">VENTAS · OPERACIÓN</p><h3>Pedidos de venta</h3><p>Se generan desde la cotización aprobada. El flete y total son estimados; cada entrega parcial factura sus fletes reales.</p></div></section>
      {orders.length === 0 ? <div className="empty-card">Aún no hay pedidos. Aprueba una cotización para generar el primero.</div> : <div className="table-card"><table><thead><tr><th>Pedido</th><th>Cliente</th><th>Fecha</th><th>Pago</th><th>Flete estimado</th><th>Crédito reservado</th><th>Estado</th><th>Total estimado</th><th /></tr></thead><tbody>
        {orders.map((order) => <tr key={order.id}><td><strong>{order.order_number}</strong></td><td>{customerNames.get(order.customer_id) ?? "Cliente no disponible"}</td><td>{date.format(new Date(order.created_at))}</td><td>{order.payment_terms}</td><td>{money.format(Number(order.freight_amount))}</td><td>{Number(order.credit_reserved_amount) > 0 ? money.format(Number(order.credit_reserved_amount)) : "—"}</td><td><span className="status-pill active">{statusLabel[order.status] ?? order.status}</span></td><td><strong>{money.format(Number(order.total))}</strong></td><td>{order.quote_id && <Link className="text-link" href={`/panel/cotizaciones/${order.quote_id}`}>Ver cotización</Link>}</td></tr>)}
      </tbody></table></div>}
    </div>
  );
}
