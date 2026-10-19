"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

function text(formData: FormData, name: string, max = 1200) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function id(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function amount(formData: FormData, name: string) {
  const parsed = Number(text(formData, name, 30) || "0");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
}
function optionalHttpUrl(value: string) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
function guatemalaDateTimeToIso(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}:00-06:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function guatemalaDateTime(value: string) {
  return new Intl.DateTimeFormat("es-GT", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Guatemala" }).format(new Date(value));
}
function failure(path: string, message: string): never { redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`); }

export async function createShipment(formData: FormData) {
  const user = await getCurrentUser();
  const orderId = text(formData, "orderId", 36);
  if (!hasAnyRole(user.roles, ["dispatch", "admin", "manager"]) || !id(orderId)) failure("/panel/despachos", "No tienes permiso o el pedido no es válido.");
  const scheduledAt = text(formData, "scheduledAt", 40);
  const scheduledAtIso = guatemalaDateTimeToIso(scheduledAt);
  const freightCost = amount(formData, "freightCost");
  const freightCharge = amount(formData, "freightCharge");
  if (!scheduledAtIso || !Number.isFinite(freightCost) || !Number.isFinite(freightCharge)) failure(`/panel/despachos/nuevo?order=${orderId}`, "Completa la fecha y los montos de flete.");
  const vehicleId = text(formData, "vehicleId", 36);
  const driverId = text(formData, "driverId", 36);
  if ((vehicleId && !id(vehicleId)) || (driverId && !id(driverId))) failure(`/panel/despachos/nuevo?order=${orderId}`, "Vehículo o piloto inválido.");
  const items = Array.from(formData.entries()).flatMap(([name, rawValue]) => {
    if (!name.startsWith("quantity_")) return [];
    const salesOrderItemId = name.slice("quantity_".length);
    const quantity = typeof rawValue === "string" ? Number(rawValue) : Number.NaN;
    return id(salesOrderItemId) && Number.isFinite(quantity) && quantity > 0
      ? [{ sales_order_item_id: salesOrderItemId, quantity }]
      : [];
  });
  if (items.length === 0) failure(`/panel/despachos/nuevo?order=${orderId}`, "Indica al menos una cantidad mayor que cero para enviar en este flete.");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_shipment", {
    p_sales_order_id: orderId, p_scheduled_at: scheduledAtIso,
    p_vehicle_id: vehicleId || null, p_driver_id: driverId || null,
    p_freight_cost: freightCost, p_freight_charge: freightCharge,
    p_recipient_name: text(formData, "recipientName", 120) || null,
    p_notes: text(formData, "notes", 1200) || null,
    p_items: items,
  });
  if (error || !data) failure(`/panel/despachos/nuevo?order=${orderId}`, error?.message || "No fue posible crear el despacho.");
  revalidatePath("/panel/despachos"); revalidatePath("/panel/pedidos");
  redirect("/panel/despachos?notice=Despacho programado correctamente.");
}

export async function advanceShipment(formData: FormData) {
  const user = await getCurrentUser();
  const shipmentId = text(formData, "shipmentId", 36);
  const nextStatus = text(formData, "nextStatus", 30);
  if (!hasAnyRole(user.roles, ["dispatch", "admin", "manager"]) || !id(shipmentId) || !['loaded', 'in_transit', 'delivered'].includes(nextStatus)) failure("/panel/despachos", "No tienes permiso o el despacho no es válido.");
  const supabase = await createClient();
  if (nextStatus === "loaded") {
    const { data: shipment, error: shipmentError } = await supabase.from("shipments").select("status, scheduled_at").eq("id", shipmentId).maybeSingle();
    if (shipmentError || !shipment) failure("/panel/despachos", "No fue posible validar el despacho antes de cargarlo.");
    if (shipment.status === "planned" && new Date(shipment.scheduled_at).getTime() > Date.now()) {
      failure("/panel/despachos", `El despacho está programado para ${guatemalaDateTime(shipment.scheduled_at)}. Reprográmalo o marca la carga cuando llegue esa hora.`);
    }
  }
  const { error } = await supabase.rpc("advance_shipment_status", { p_shipment_id: shipmentId, p_next_status: nextStatus, p_notes: text(formData, "notes", 1200) || null });
  if (error) failure("/panel/despachos", error.message || "No fue posible avanzar el despacho.");
  revalidatePath("/panel/despachos"); revalidatePath("/panel/pedidos"); revalidatePath("/panel/cotizaciones");
  redirect("/panel/despachos?notice=Estado del despacho actualizado.");
}

export async function rescheduleShipment(formData: FormData) {
  const user = await getCurrentUser();
  const shipmentId = text(formData, "shipmentId", 36);
  const scheduledAtIso = guatemalaDateTimeToIso(text(formData, "scheduledAt", 40));
  if (!hasAnyRole(user.roles, ["dispatch", "admin", "manager"]) || !id(shipmentId) || !scheduledAtIso) failure("/panel/despachos", "Indica una fecha y hora válidas para reprogramar el despacho.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("reschedule_shipment", { p_shipment_id: shipmentId, p_scheduled_at: scheduledAtIso });
  if (error) failure("/panel/despachos", error.message || "No fue posible reprogramar el despacho.");
  revalidatePath("/panel/despachos"); revalidatePath("/panel/alertas");
  redirect("/panel/despachos?notice=Despacho reprogramado correctamente.");
}

export async function confirmShipmentDelivery(formData: FormData) {
  const user = await getCurrentUser();
  const shipmentId = text(formData, "shipmentId", 36);
  const recipientName = text(formData, "recipientName", 120);
  const signatureUrlValue = text(formData, "signatureUrl", 500);
  const signatureUrl = optionalHttpUrl(signatureUrlValue);
  if (!hasAnyRole(user.roles, ["dispatch", "admin", "manager"]) || !id(shipmentId)) failure("/panel/despachos", "No tienes permiso o el despacho no es válido.");
  if (!recipientName) failure("/panel/despachos", "Indica quién recibió la entrega.");
  if (signatureUrlValue && !signatureUrl) failure("/panel/despachos", "El enlace de evidencia debe iniciar con http:// o https://.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("confirm_shipment_delivery", {
    p_shipment_id: shipmentId,
    p_recipient_name: recipientName,
    p_recipient_signature_url: signatureUrl,
    p_observations: text(formData, "observations", 1200) || null,
  });
  if (error) failure("/panel/despachos", error.message || "No fue posible confirmar la entrega.");
  revalidatePath("/panel/despachos"); revalidatePath("/panel/pedidos"); revalidatePath("/panel/cotizaciones"); revalidatePath("/panel/alertas"); revalidatePath("/panel/reportes");
  redirect("/panel/despachos?notice=Entrega confirmada y registrada correctamente.");
}

export async function registerShipmentIncident(formData: FormData) {
  const user = await getCurrentUser();
  const shipmentId = text(formData, "shipmentId", 36);
  const incidentType = text(formData, "incidentType", 40);
  const description = text(formData, "description", 1200);
  const occurredAtInput = text(formData, "occurredAt", 40);
  const allowedTypes = ["delivery_delay", "vehicle_issue", "damaged_product", "route_issue", "customer_issue", "other"];
  if (!hasAnyRole(user.roles, ["dispatch", "admin", "manager"]) || !id(shipmentId)) failure("/panel/despachos", "No tienes permiso o el despacho no es válido.");
  if (!allowedTypes.includes(incidentType) || description.length < 10) failure("/panel/despachos", "Selecciona un tipo y describe la incidencia con al menos 10 caracteres.");
  const occurredAtIso = occurredAtInput ? guatemalaDateTimeToIso(occurredAtInput) : new Date().toISOString();
  if (!occurredAtIso) failure("/panel/despachos", "La fecha de la incidencia no es válida.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("register_shipment_incident", {
    p_shipment_id: shipmentId,
    p_incident_type: incidentType,
    p_description: description,
    p_occurred_at: occurredAtIso,
  });
  if (error) failure("/panel/despachos", error.message || "No fue posible registrar la incidencia.");
  revalidatePath("/panel/despachos"); revalidatePath("/panel/alertas"); revalidatePath("/panel/reportes");
  redirect("/panel/despachos?notice=Incidencia registrada para seguimiento.");
}

export async function resolveShipmentIncident(formData: FormData) {
  const user = await getCurrentUser();
  const incidentId = text(formData, "incidentId", 36);
  const resolutionNotes = text(formData, "resolutionNotes", 1200);
  if (!hasAnyRole(user.roles, ["dispatch", "admin", "manager"]) || !id(incidentId) || resolutionNotes.length < 5) failure("/panel/despachos", "Describe la resolución de la incidencia antes de cerrarla.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("resolve_shipment_incident", { p_incident_id: incidentId, p_resolution_notes: resolutionNotes });
  if (error) failure("/panel/despachos", error.message || "No fue posible cerrar la incidencia.");
  revalidatePath("/panel/despachos"); revalidatePath("/panel/alertas"); revalidatePath("/panel/reportes");
  redirect("/panel/despachos?notice=Incidencia cerrada correctamente.");
}

export async function createVehicle(formData: FormData) {
  const user = await getCurrentUser();
  if (!hasAnyRole(user.roles, ["dispatch", "admin", "manager"])) failure("/panel/despachos", "No tienes permiso para administrar vehículos.");
  const plate = text(formData, "plate", 20).toUpperCase();
  if (!plate) failure("/panel/despachos", "Ingresa la placa del vehículo.");
  const capacity = text(formData, "capacityKg", 30);
  let capacityValue: number | null = null;
  if (capacity) {
    const parsedCapacity = Number(capacity);
    if (!Number.isFinite(parsedCapacity) || parsedCapacity <= 0) failure("/panel/despachos", "La capacidad debe ser mayor a cero.");
    capacityValue = parsedCapacity;
  }
  const supabase = await createClient();
  const { error } = await supabase.from("vehicles").insert({ plate, description: text(formData, "description", 250) || null, capacity_kg: capacityValue });
  if (error) failure("/panel/despachos", error.message || "No fue posible guardar el vehículo.");
  revalidatePath("/panel/despachos"); redirect("/panel/despachos?notice=Vehículo agregado.");
}

export async function createDriver(formData: FormData) {
  const user = await getCurrentUser();
  if (!hasAnyRole(user.roles, ["dispatch", "admin", "manager"])) failure("/panel/despachos", "No tienes permiso para administrar pilotos.");
  const fullName = text(formData, "fullName", 120);
  if (!fullName) failure("/panel/despachos", "Ingresa el nombre del piloto.");
  const supabase = await createClient();
  const { error } = await supabase.from("drivers").insert({ full_name: fullName, license_number: text(formData, "licenseNumber", 80) || null, phone: text(formData, "phone", 40) || null });
  if (error) failure("/panel/despachos", error.message || "No fue posible guardar el piloto.");
  revalidatePath("/panel/despachos"); redirect("/panel/despachos?notice=Piloto agregado.");
}
