"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

function text(formData: FormData, name: string, max = 300) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function numberValue(formData: FormData, name: string) {
  const value = Number(text(formData, name, 30));
  return Number.isFinite(value) ? value : Number.NaN;
}
function validUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function failure(message: string): never {
  redirect(`/panel/produccion?error=${encodeURIComponent(message)}`);
}

export async function createInventoryLocation(formData: FormData) {
  const user = await getCurrentUser();
  if (!hasAnyRole(user.roles, ["admin", "manager"])) failure("Sólo Administración o Gerencia puede crear ubicaciones.");
  const code = text(formData, "code", 30).toUpperCase();
  const name = text(formData, "name", 120);
  const locationType = text(formData, "locationType", 20);
  if (!code || !name || !['plant', 'yard', 'warehouse', 'transit'].includes(locationType)) failure("Completa los datos de la ubicación.");
  const supabase = await createClient();
  const { error } = await supabase.from("inventory_locations").insert({ code, name, location_type: locationType });
  if (error) failure(error.message || "No fue posible guardar la ubicación.");
  revalidatePath("/panel/produccion");
  redirect("/panel/produccion?notice=Ubicación creada correctamente.");
}

export async function recordProduction(formData: FormData) {
  const user = await getCurrentUser();
  if (!hasAnyRole(user.roles, ["plant", "admin", "manager"])) failure("No tienes permiso para registrar producción.");
  const productId = text(formData, "productId", 36);
  const locationId = text(formData, "locationId", 36);
  const materialLocationId = text(formData, "materialLocationId", 36);
  const produced = numberValue(formData, "produced");
  const rejectedText = text(formData, "rejected", 30);
  const rejected = rejectedText ? Number(rejectedText) : 0;
  const curingHours = Number(text(formData, "curingHours", 10));
  if (!validUuid(productId) || !validUuid(locationId) || !validUuid(materialLocationId) || !Number.isFinite(produced) || produced <= 0 || !Number.isFinite(rejected) || rejected < 0 || rejected > produced || !Number.isInteger(curingHours) || curingHours < 1 || curingHours > 720) failure("Verifica producto, ubicaciones, cantidades y horas de curado.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("start_production_batch", {
    p_product_id: productId,
    p_product_location_id: locationId,
    p_material_location_id: materialLocationId,
    p_production_date: text(formData, "productionDate", 10) || null,
    p_shift: text(formData, "shift", 40) || null,
    p_quantity_produced: produced,
    p_quantity_rejected: rejected,
    p_curing_hours: curingHours,
    p_notes: text(formData, "notes", 1200) || null,
  });
  if (error) failure(error.message || "No fue posible registrar el lote.");
  revalidatePath("/panel/produccion");
  revalidatePath("/panel");
  redirect("/panel/produccion?notice=Lote fresco iniciado. La materia prima fue descontada; inicia el curado cuando corresponda.");
}

export async function createRawMaterial(formData: FormData) {
  const user = await getCurrentUser();
  if (!hasAnyRole(user.roles, ["admin", "manager"])) failure("Sólo Administración o Gerencia puede crear materias primas.");
  const sku = text(formData, "sku", 60).toUpperCase();
  const name = text(formData, "name", 160);
  const unit = text(formData, "unit", 30).toLowerCase();
  const minimumStock = numberValue(formData, "minimumStock");
  if (!sku || !name || !unit || !Number.isFinite(minimumStock) || minimumStock < 0) failure("Completa código, nombre, unidad y stock mínimo.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_raw_material", { p_sku: sku, p_name: name, p_unit: unit, p_minimum_stock: minimumStock });
  if (error) failure(error.code === "23505" ? "Ya existe una materia prima con ese código." : error.message || "No fue posible crear la materia prima.");
  revalidatePath("/panel/produccion");
  redirect("/panel/produccion?notice=Materia prima creada correctamente.");
}

export async function receiveRawMaterial(formData: FormData) {
  const user = await getCurrentUser();
  if (!hasAnyRole(user.roles, ["plant", "warehouse", "dispatch", "admin", "manager"])) failure("No tienes permiso para registrar ingresos de materia prima.");
  const rawMaterialId = text(formData, "rawMaterialId", 36);
  const locationId = text(formData, "locationId", 36);
  const received = numberValue(formData, "received");
  const costText = text(formData, "unitCost", 30);
  const unitCost = costText ? Number(costText) : null;
  if (!validUuid(rawMaterialId) || !validUuid(locationId) || !Number.isFinite(received) || received <= 0 || (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0))) failure("Verifica materia prima, ubicación, cantidad y costo unitario.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("receive_raw_material", {
    p_raw_material_id: rawMaterialId, p_location_id: locationId, p_quantity: received, p_unit_cost: unitCost,
    p_supplier: text(formData, "supplier", 160) || null, p_reference: text(formData, "reference", 120) || null,
    p_notes: text(formData, "notes", 1200) || null,
  });
  if (error) failure(error.message || "No fue posible registrar el ingreso de materia prima.");
  revalidatePath("/panel/produccion");
  redirect("/panel/produccion?notice=Ingreso de materia prima registrado.");
}

export async function saveMaterialRequirement(formData: FormData) {
  const user = await getCurrentUser();
  if (!hasAnyRole(user.roles, ["admin", "manager"])) failure("Sólo Administración o Gerencia puede modificar fórmulas.");
  const productId = text(formData, "productId", 36);
  const rawMaterialId = text(formData, "rawMaterialId", 36);
  const quantityPerUnit = numberValue(formData, "quantityPerUnit");
  if (!validUuid(productId) || !validUuid(rawMaterialId) || !Number.isFinite(quantityPerUnit) || quantityPerUnit <= 0) failure("Selecciona producto, materia prima y una cantidad por unidad válida.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_product_material_requirement", { p_product_id: productId, p_raw_material_id: rawMaterialId, p_quantity_per_unit: quantityPerUnit });
  if (error) failure(error.message || "No fue posible guardar la fórmula.");
  revalidatePath("/panel/produccion");
  redirect("/panel/produccion?notice=Fórmula de fabricación actualizada.");
}

export async function removeMaterialRequirement(formData: FormData) {
  const user = await getCurrentUser();
  const productId = text(formData, "productId", 36);
  const rawMaterialId = text(formData, "rawMaterialId", 36);
  if (!hasAnyRole(user.roles, ["admin", "manager"]) || !validUuid(productId) || !validUuid(rawMaterialId)) failure("No fue posible quitar este componente de la fórmula.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_product_material_requirement", { p_product_id: productId, p_raw_material_id: rawMaterialId });
  if (error) failure(error.message || "No fue posible quitar el componente de la fórmula.");
  revalidatePath("/panel/produccion");
  redirect("/panel/produccion?notice=Componente eliminado de la fórmula.");
}

export async function beginBatchCuring(formData: FormData) {
  const user = await getCurrentUser();
  const batchId = text(formData, "batchId", 36);
  if (!hasAnyRole(user.roles, ["plant", "admin", "manager"]) || !validUuid(batchId)) failure("No tienes permiso o el lote no es válido.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("begin_production_batch_curing", { p_batch_id: batchId });
  if (error) failure(error.message || "No fue posible iniciar el curado.");
  revalidatePath("/panel/produccion");
  redirect("/panel/produccion?notice=Curado iniciado. El lote se liberará al cumplir el tiempo definido.");
}

export async function releaseBatchForSale(formData: FormData) {
  const user = await getCurrentUser();
  const batchId = text(formData, "batchId", 36);
  if (!hasAnyRole(user.roles, ["plant", "admin", "manager"]) || !validUuid(batchId)) failure("No tienes permiso o el lote no es válido.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("release_production_batch", { p_batch_id: batchId });
  if (error) failure(error.message || "No fue posible liberar el lote.");
  revalidatePath("/panel/produccion"); revalidatePath("/panel/despachos"); revalidatePath("/panel/cotizaciones/nueva"); revalidatePath("/panel");
  redirect("/panel/produccion?notice=Lote listo para venta. El inventario vendible y las reservas fueron actualizados.");
}

export async function reallocateInventory(formData: FormData) {
  const user = await getCurrentUser();
  const sourceOrderItemId = text(formData, "sourceOrderItemId", 36);
  const targetOrderItemId = text(formData, "targetOrderItemId", 36);
  const quantity = numberValue(formData, "quantity");
  if (!hasAnyRole(user.roles, ["plant", "dispatch", "admin", "manager"]) || !validUuid(sourceOrderItemId) || !validUuid(targetOrderItemId) || !Number.isFinite(quantity) || quantity <= 0) failure("Verifica las líneas y la cantidad a reasignar.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("reallocate_inventory_reservation", {
    p_from_order_item_id: sourceOrderItemId,
    p_to_order_item_id: targetOrderItemId,
    p_quantity: quantity,
    p_reason: text(formData, "reason", 1200) || null,
  });
  if (error) failure(error.message || "No fue posible reasignar la reserva.");
  revalidatePath("/panel/produccion"); revalidatePath("/panel/despachos"); revalidatePath("/panel/cotizaciones/nueva");
  redirect("/panel/produccion?notice=Reserva reasignada correctamente.");
}
