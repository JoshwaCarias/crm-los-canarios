import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

import {
  advanceShipment,
  confirmShipmentDelivery,
  createDriver,
  createVehicle,
  registerShipmentIncident,
  rescheduleShipment,
  resolveShipmentIncident,
} from "./actions";

type Order = { id: string; order_number: string; customer_id: string; total: number | string; freight_amount: number | string; status: string };
type Customer = { id: string; legal_name: string };
type Shipment = {
  id: string; shipment_number: string; status: string; scheduled_at: string; delivered_at: string | null;
  vehicle_id: string | null; driver_id: string | null; freight_cost: number | string; freight_charge: number | string;
  recipient_name: string | null; recipient_signature_url: string | null; delivery_notes: string | null;
};
type Incident = { id: string; shipment_id: string; incident_type: string; description: string; status: string; occurred_at: string; resolution_notes: string | null };
type Vehicle = { id: string; plate: string };
type Driver = { id: string; full_name: string };

const money = new Intl.NumberFormat("es-GT", { style: "currency", currency: "GTQ" });
const date = new Intl.DateTimeFormat("es-GT", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Guatemala" });
const shipmentLabels: Record<string, string> = { planned: "Programado", loaded: "Cargado", in_transit: "En ruta", delivered: "Entregado", partially_delivered: "Parcial", cancelled: "Cancelado" };
const incidentLabels: Record<string, string> = { delivery_delay: "Retraso", vehicle_issue: "Vehículo", damaged_product: "Producto dañado", route_issue: "Ruta", customer_issue: "Cliente", other: "Otro" };
const nextAction: Record<string, { status: string; label: string } | undefined> = { planned: { status: "loaded", label: "Marcar carga" }, loaded: { status: "in_transit", label: "Salida a ruta" } };

function IncidentForm({ shipmentId }: { shipmentId: string }) {
  return <details className="operation-details"><summary>Registrar incidencia</summary><form className="operation-form" action={registerShipmentIncident}><input type="hidden" name="shipmentId" value={shipmentId} /><label>Tipo<select name="incidentType" defaultValue="delivery_delay"><option value="delivery_delay">Retraso de entrega</option><option value="vehicle_issue">Problema de vehículo</option><option value="damaged_product">Producto dañado</option><option value="route_issue">Problema de ruta</option><option value="customer_issue">Situación con cliente</option><option value="other">Otro</option></select></label><label>Detalle<textarea name="description" rows={3} minLength={10} maxLength={1200} required placeholder="Describe qué ocurrió y la acción tomada." /></label><label>Fecha y hora<input name="occurredAt" type="datetime-local" /></label><button type="submit">Guardar incidencia</button></form></details>;
}

function DeliveryForm({ shipment }: { shipment: Shipment }) {
  return <details className="operation-details delivery"><summary>Confirmar entrega</summary><form className="operation-form" action={confirmShipmentDelivery}><input type="hidden" name="shipmentId" value={shipment.id} /><label>Recibe *<input name="recipientName" maxLength={120} required defaultValue={shipment.recipient_name ?? ""} /></label><label>Enlace de firma o evidencia<input name="signatureUrl" type="url" maxLength={500} placeholder="https://..." /></label><label>Observaciones<textarea name="observations" rows={3} maxLength={1200} placeholder="Entrega completa, faltantes, condiciones de descarga..." defaultValue={shipment.delivery_notes ?? ""} /></label><button type="submit">Confirmar entrega</button></form></details>;
}

function shipmentDateTimeInput(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Guatemala", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function RescheduleForm({ shipment }: { shipment: Shipment }) {
  return <details className="operation-details"><summary>Reprogramar carga</summary><form className="operation-form" action={rescheduleShipment}><input type="hidden" name="shipmentId" value={shipment.id} /><label>Nueva fecha y hora *<input name="scheduledAt" type="datetime-local" required defaultValue={shipmentDateTimeInput(shipment.scheduled_at)} /></label><button type="submit">Guardar nueva hora</button></form></details>;
}

export default async function DispatchPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const [user, messages, supabase] = await Promise.all([getCurrentUser(), searchParams, createClient()]);
  const allowed = hasAnyRole(user.roles, ["dispatch", "admin", "manager"]);
  if (!allowed) return <div className="module-page"><section className="module-header"><div><p className="eyebrow">DESPACHO</p><h3>Despachos y fletes</h3><p>No tienes permiso para este módulo.</p></div></section></div>;

  const [ordersResult, shipmentsResult, vehiclesResult, driversResult, incidentsResult, deliveredResult] = await Promise.all([
    supabase.from("sales_orders").select("id, order_number, customer_id, total, freight_amount, status").in("status", ["ready_for_dispatch", "partially_delivered"]).order("created_at").limit(50),
    supabase.from("shipments").select("id, shipment_number, status, scheduled_at, delivered_at, vehicle_id, driver_id, freight_cost, freight_charge, recipient_name, recipient_signature_url, delivery_notes").in("status", ["planned", "loaded", "in_transit"]).order("scheduled_at").limit(50),
    supabase.from("vehicles").select("id, plate").eq("is_active", true),
    supabase.from("drivers").select("id, full_name").eq("is_active", true),
    supabase.from("incidents").select("id, shipment_id, incident_type, description, status, occurred_at, resolution_notes").in("status", ["open", "in_progress"]).order("occurred_at", { ascending: false }).limit(50),
    supabase.from("shipments").select("id, shipment_number, status, scheduled_at, delivered_at, vehicle_id, driver_id, freight_cost, freight_charge, recipient_name, recipient_signature_url, delivery_notes").eq("status", "delivered").order("delivered_at", { ascending: false }).limit(12),
  ]);

  const orders = (ordersResult.data ?? []) as Order[];
  const shipments = (shipmentsResult.data ?? []) as Shipment[];
  const incidents = (incidentsResult.data ?? []) as Incident[];
  const deliveredShipments = (deliveredResult.data ?? []) as Shipment[];
  const customersResult = orders.length ? await supabase.from("customers").select("id, legal_name").in("id", [...new Set(orders.map((order) => order.customer_id))]) : { data: [] as Customer[] };
  const customerNames = new Map(((customersResult.data ?? []) as Customer[]).map((customer) => [customer.id, customer.legal_name]));
  const vehicleNames = new Map(((vehiclesResult.data ?? []) as Vehicle[]).map((vehicle) => [vehicle.id, vehicle.plate]));
  const driverNames = new Map(((driversResult.data ?? []) as Driver[]).map((driver) => [driver.id, driver.full_name]));
  const shipmentNames = new Map([...shipments, ...deliveredShipments].map((shipment) => [shipment.id, shipment.shipment_number]));

  return <div className="module-page">
    <section className="module-header"><div><p className="eyebrow">LOGÍSTICA · FLETES</p><h3>Despachos</h3><p>Programa entregas parciales, varios camiones por día y el flete real que se incluirá al facturar cada entrega.</p></div></section>
    {messages.error && <p className="alert" role="alert">{messages.error}</p>}{messages.notice && <p className="notice success" role="status">{messages.notice}</p>}

    <section className="detail-section"><div className="section-heading"><h3>Pedidos con saldo para despacho</h3><span>{orders.length} pendientes o parciales</span></div>{orders.length === 0 ? <div className="empty-inline">No hay pedidos autorizados con saldo reservado para despacho.</div> : <div className="table-card"><table><thead><tr><th>Pedido</th><th>Cliente</th><th>Flete estimado</th><th>Total estimado</th><th /></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td>{order.order_number}<small>{order.status === "partially_delivered" ? "Entrega parcial en curso" : "Listo para despacho"}</small></td><td>{customerNames.get(order.customer_id) ?? "—"}</td><td>{money.format(Number(order.freight_amount))}</td><td>{money.format(Number(order.total))}</td><td><Link className="button-link" href={`/panel/despachos/nuevo?order=${order.id}`}>Programar flete</Link></td></tr>)}</tbody></table></div>}</section>

    <section className="detail-section"><div className="section-heading"><h3>Despachos activos</h3><span>La entrega pasa a pedido y cotización como completada.</span></div>{shipments.length === 0 ? <div className="empty-inline">No hay despachos activos.</div> : <div className="table-card"><table><thead><tr><th>Despacho</th><th>Programado</th><th>Vehículo / piloto</th><th>Flete real</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{shipments.map((shipment) => { const action = nextAction[shipment.status]; return <tr key={shipment.id}><td><strong>{shipment.shipment_number}</strong>{shipment.recipient_name && <small>Contacto previsto: {shipment.recipient_name}</small>}</td><td>{date.format(new Date(shipment.scheduled_at))}</td><td>{shipment.vehicle_id ? vehicleNames.get(shipment.vehicle_id) ?? "Vehículo no disponible" : "Sin vehículo"}<small>{shipment.driver_id ? driverNames.get(shipment.driver_id) ?? "Piloto no disponible" : "Sin piloto"}</small></td><td><strong>{money.format(Number(shipment.freight_charge))}</strong><small>Costo: {money.format(Number(shipment.freight_cost))}</small></td><td><span className="status-pill active">{shipmentLabels[shipment.status] ?? shipment.status}</span></td><td><div className="shipment-actions">{action && <form action={advanceShipment}><input type="hidden" name="shipmentId" value={shipment.id} /><input type="hidden" name="nextStatus" value={action.status} /><button className="button-secondary" type="submit">{action.label}</button></form>}{shipment.status === "planned" && <RescheduleForm shipment={shipment} />}{shipment.status === "in_transit" && <DeliveryForm shipment={shipment} />}<IncidentForm shipmentId={shipment.id} /></div></td></tr>; })}</tbody></table></div>}</section>

    <section className="detail-section"><div className="section-heading"><h3>Incidencias abiertas</h3><span>{incidents.length} por resolver</span></div>{incidents.length === 0 ? <div className="empty-inline">No hay incidencias abiertas en los despachos.</div> : <div className="incident-list">{incidents.map((incident) => <article key={incident.id}><div><span className="mini-tag">{incidentLabels[incident.incident_type] ?? incident.incident_type}</span><strong>{shipmentNames.get(incident.shipment_id) ?? "Despacho"}</strong><small>{date.format(new Date(incident.occurred_at))}</small></div><p>{incident.description}</p><details className="operation-details"><summary>Resolver incidencia</summary><form className="operation-form" action={resolveShipmentIncident}><input type="hidden" name="incidentId" value={incident.id} /><label>Resolución<textarea name="resolutionNotes" rows={3} minLength={5} maxLength={1200} required placeholder="Indica cómo se resolvió y quién dio seguimiento." /></label><button type="submit">Cerrar incidencia</button></form></details></article>)}</div>}</section>

    <section className="detail-section"><div className="section-heading"><h3>Entregas recientes</h3><span>Contabilidad factura por entrega diaria una vez que sus fletes estén confirmados.</span></div>{deliveredShipments.length === 0 ? <div className="empty-inline">Aún no hay entregas confirmadas.</div> : <div className="delivery-list">{deliveredShipments.map((shipment) => <article key={shipment.id}><div><strong>{shipment.shipment_number}</strong><span className="status-pill active">Entregado</span></div><p>Recibió: {shipment.recipient_name ?? "Pendiente de confirmar"}{shipment.delivered_at && ` · ${date.format(new Date(shipment.delivered_at))}`}</p>{shipment.delivery_notes && <small>{shipment.delivery_notes}</small>}{shipment.recipient_signature_url && <a href={shipment.recipient_signature_url} target="_blank" rel="noreferrer">Abrir evidencia de entrega</a>}</article>)}</div>}</section>

    <section className="detail-section"><div className="section-heading"><h3>Catálogo de transporte</h3><span>Agrega vehículos y pilotos para asignarlos al programar cada flete.</span></div><div className="detail-grid"><form className="inline-form form-grid" action={createVehicle}><h4 className="full-width">Nuevo vehículo</h4><label>Placa *<input name="plate" maxLength={20} required /></label><label>Descripción<input name="description" maxLength={250} placeholder="Camión 10 toneladas" /></label><label>Capacidad (kg)<input name="capacityKg" type="number" min="1" step="0.01" /></label><button type="submit">Agregar vehículo</button></form><form className="inline-form form-grid" action={createDriver}><h4 className="full-width">Nuevo piloto</h4><label>Nombre completo *<input name="fullName" maxLength={120} required /></label><label>Licencia<input name="licenseNumber" maxLength={80} /></label><label>Teléfono<input name="phone" maxLength={40} /></label><button type="submit">Agregar piloto</button></form></div></section>
  </div>;
}
