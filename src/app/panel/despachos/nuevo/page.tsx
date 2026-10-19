import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

import { createShipment } from "../actions";

type Order = { id: string; order_number: string; customer_id: string; delivery_site_id: string | null; status: string; freight_amount: number | string };
type Customer = { legal_name: string };
type Site = { name: string; address: string };
type Vehicle = { id: string; plate: string; description: string | null };
type Driver = { id: string; full_name: string; phone: string | null };
type FulfillmentLine = { id: string; description: string; orderedQuantity: number | string; deliveredQuantity: number | string; reservedQuantity: number | string; scheduledQuantity: number | string; dispatchableQuantity: number | string; productionRequired: number | string };
type Fulfillment = { lines: FulfillmentLine[] };

const quantity = new Intl.NumberFormat("es-GT", { maximumFractionDigits: 3 });
const money = new Intl.NumberFormat("es-GT", { style: "currency", currency: "GTQ" });

export default async function NewShipmentPage({ searchParams }: { searchParams: Promise<{ order?: string; error?: string }> }) {
  const [user, params, supabase] = await Promise.all([getCurrentUser(), searchParams, createClient()]);
  if (!hasAnyRole(user.roles, ["dispatch", "admin", "manager"]) || !params.order) redirect("/panel/despachos");
  const [orderResult, vehiclesResult, driversResult, fulfillmentResult] = await Promise.all([
    supabase.from("sales_orders").select("id, order_number, customer_id, delivery_site_id, status, freight_amount").eq("id", params.order).maybeSingle(),
    supabase.from("vehicles").select("id, plate, description").eq("is_active", true).order("plate"),
    supabase.from("drivers").select("id, full_name, phone").eq("is_active", true).order("full_name"),
    supabase.rpc("get_order_fulfillment", { p_sales_order_id: params.order }),
  ]);
  const order = orderResult.data as Order | null;
  const fulfillment = fulfillmentResult.data as Fulfillment | null;
  if (!order || !fulfillment || !["ready_for_dispatch", "partially_delivered"].includes(order.status)) redirect("/panel/despachos?error=El pedido no está disponible para despacho.");
  const [customerResult, siteResult] = await Promise.all([
    supabase.from("customers").select("legal_name").eq("id", order.customer_id).maybeSingle(),
    order.delivery_site_id ? supabase.from("delivery_sites").select("name, address").eq("id", order.delivery_site_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const customer = customerResult.data as Customer | null;
  const site = siteResult.data as Site | null;
  const vehicles = (vehiclesResult.data ?? []) as Vehicle[];
  const drivers = (driversResult.data ?? []) as Driver[];
  const dispatchableLines = fulfillment.lines.filter((line) => Number(line.dispatchableQuantity) > 0);

  return <div className="module-page narrow-page"><div className="breadcrumb"><Link href="/panel/despachos">Despachos</Link><span>/</span><span>Programar entrega parcial</span></div><section className="module-header compact"><div><p className="eyebrow">DESPACHO · ENTREGA PARCIAL</p><h3>Programar {order.order_number}</h3><p>{customer?.legal_name ?? "Cliente"} · {site ? `${site.name}: ${site.address}` : "Sin dirección de entrega"}</p></div></section>{params.error && <p className="alert">{params.error}</p>}
    <section className="detail-section fulfillment-help"><strong>Entrega e invoice por día</strong><p>Los camiones de este pedido programados para la misma fecha se agrupan en una entrega parcial y se facturan juntos, con el flete real de cada uno.</p><span>Flete estimado comercial: {money.format(Number(order.freight_amount))}</span></section>
    {dispatchableLines.length === 0 ? <section className="detail-section"><h3>Aún no hay producto reservado para enviar</h3><p className="form-help">Las cantidades en rojo deben fabricarse. Si existe inventario reservado para otro pedido, Administración o Logística puede decidir manualmente si lo reasigna desde Producción e inventario.</p><div className="table-card fulfillment-table"><table><thead><tr><th>Producto</th><th>Pedido</th><th>Entregado</th><th>Reservado</th><th>Ya programado</th><th>Por fabricar</th></tr></thead><tbody>{fulfillment.lines.map((line) => <tr key={line.id}><td>{line.description}</td><td>{quantity.format(Number(line.orderedQuantity))}</td><td>{quantity.format(Number(line.deliveredQuantity))}</td><td><strong className="quantity-positive">{quantity.format(Number(line.reservedQuantity))}</strong></td><td>{quantity.format(Number(line.scheduledQuantity))}</td><td><strong className={Number(line.productionRequired) > 0 ? "quantity-negative" : "quantity-muted"}>{quantity.format(Number(line.productionRequired))}</strong></td></tr>)}</tbody></table></div><div className="form-actions"><Link className="button-secondary button-link" href="/panel/despachos">Volver a Despachos</Link><Link className="button-link" href="/panel/produccion">Abrir Producción e inventario</Link></div></section> : <form className="form-card form-grid" action={createShipment}><input type="hidden" name="orderId" value={order.id} /><div className="full-width table-card fulfillment-table"><table><thead><tr><th>Producto</th><th>Pedido</th><th>Entregado</th><th>Reservado</th><th>Ya programado</th><th>Disponible para este flete</th><th>Fabricar</th><th>Enviar ahora</th></tr></thead><tbody>{fulfillment.lines.map((line) => { const dispatchable = Number(line.dispatchableQuantity); return <tr key={line.id}><td>{line.description}</td><td>{quantity.format(Number(line.orderedQuantity))}</td><td>{quantity.format(Number(line.deliveredQuantity))}</td><td>{quantity.format(Number(line.reservedQuantity))}</td><td>{quantity.format(Number(line.scheduledQuantity))}</td><td><strong className={dispatchable > 0 ? "quantity-positive" : "quantity-muted"}>{quantity.format(dispatchable)}</strong></td><td><strong className={Number(line.productionRequired) > 0 ? "quantity-negative" : "quantity-muted"}>{quantity.format(Number(line.productionRequired))}</strong></td><td><input name={`quantity_${line.id}`} type="number" min="0" max={dispatchable} step="0.001" defaultValue="0" disabled={dispatchable <= 0} /></td></tr>; })}</tbody></table></div><label>Fecha y hora de carga *<input name="scheduledAt" type="datetime-local" required /></label><label>Cobro de flete al cliente (Q) *<input name="freightCharge" type="number" min="0" step="0.01" defaultValue="0" required /></label><label>Costo real del flete (Q) *<input name="freightCost" type="number" min="0" step="0.01" defaultValue="0" required /></label><label>Vehículo<select name="vehicleId"><option value="">Sin asignar por ahora</option>{vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.plate}{vehicle.description ? ` · ${vehicle.description}` : ""}</option>)}</select></label><label>Piloto<select name="driverId"><option value="">Sin asignar por ahora</option>{drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.full_name}{driver.phone ? ` · ${driver.phone}` : ""}</option>)}</select></label><label>Nombre de quien recibe<input name="recipientName" maxLength={120} /></label><label className="full-width">Observaciones<textarea name="notes" rows={3} maxLength={1200} placeholder="Indicaciones de carga, contacto en obra u observaciones" /></label><div className="form-actions full-width"><Link className="button-secondary button-link" href="/panel/despachos">Cancelar</Link><button type="submit">Programar flete parcial</button></div></form>}</div>;
}
