"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { canManageCustomers } from "@/lib/permissions";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

function value(formData: FormData, name: string, maxLength = 500) {
  const item = formData.get(name);
  return typeof item === "string" ? item.trim().slice(0, maxLength) : "";
}

function isValidEmail(email: string) {
  return !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isUuid(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function coordinate(formData: FormData, name: string) {
  const raw = value(formData, name, 30);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function failure(path: string, message: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
}

function databaseError(path: string, error: { code?: string; message: string }): never {
  if (error.code === "23505") {
    failure(path, "Ya existe un cliente con ese NIT.");
  }

  failure(path, "No fue posible guardar la información. Intenta nuevamente.");
}

export async function createCustomer(formData: FormData) {
  const user = await getCurrentUser();
  if (!canManageCustomers(user.roles)) failure("/panel/clientes/nuevo", "No tienes permiso para crear clientes.");

  const legalName = value(formData, "legalName", 180);
  const tradeName = value(formData, "tradeName", 180);
  const nit = value(formData, "nit", 30).toUpperCase();
  const phone = value(formData, "phone", 40);
  const email = value(formData, "email", 120).toLowerCase();
  const requestedSellerId = value(formData, "assignedSellerId", 36);

  if (!legalName || !nit) failure("/panel/clientes/nuevo", "La razón social y el NIT son obligatorios.");
  if (!isValidEmail(email)) failure("/panel/clientes/nuevo", "Ingresa un correo electrónico válido.");
  if (requestedSellerId && !isUuid(requestedSellerId)) failure("/panel/clientes/nuevo", "El vendedor seleccionado no es válido.");

  // Crédito se controla por Contabilidad/Gerencia en una fase posterior. Los
  // vendedores crean clientes con crédito inicial de cero.
  const isPrivileged = hasAnyRole(user.roles, ["admin", "manager"]);
  const creditLimitRaw = value(formData, "creditLimit", 30);
  const creditDaysRaw = value(formData, "creditDays", 10);
  const creditLimit = isPrivileged && creditLimitRaw ? Number(creditLimitRaw) : 0;
  const creditDays = isPrivileged && creditDaysRaw ? Number(creditDaysRaw) : 0;

  if (!Number.isFinite(creditLimit) || creditLimit < 0 || !Number.isInteger(creditDays) || creditDays < 0) {
    failure("/panel/clientes/nuevo", "Los datos de crédito no son válidos.");
  }

  const supabase = await createClient();
  const { error } = await supabase.from("customers").insert({
    legal_name: legalName,
    trade_name: tradeName || null,
    nit,
    phone: phone || null,
    email: email || null,
    credit_limit: creditLimit,
    credit_days: creditDays,
    assigned_seller_id: user.roles.includes("admin") && requestedSellerId ? requestedSellerId : null,
    created_by: user.id,
  });

  if (error) databaseError("/panel/clientes/nuevo", error);

  revalidatePath("/panel/clientes");
  revalidatePath("/panel");
  redirect("/panel/clientes?created=1");
}

export async function addCustomerContact(formData: FormData) {
  const user = await getCurrentUser();
  const customerId = value(formData, "customerId", 36);
  const path = `/panel/clientes/${customerId}`;

  if (!canManageCustomers(user.roles)) failure(path, "No tienes permiso para agregar contactos.");
  if (!isUuid(customerId)) failure("/panel/clientes", "Cliente inválido.");

  const fullName = value(formData, "fullName", 150);
  const jobTitle = value(formData, "jobTitle", 100);
  const phone = value(formData, "phone", 40);
  const email = value(formData, "email", 120).toLowerCase();

  if (!fullName) failure(path, "El nombre del contacto es obligatorio.");
  if (!isValidEmail(email)) failure(path, "Ingresa un correo electrónico válido.");

  const supabase = await createClient();
  const { error } = await supabase.from("customer_contacts").insert({
    customer_id: customerId,
    full_name: fullName,
    job_title: jobTitle || null,
    phone: phone || null,
    email: email || null,
  });

  if (error) databaseError(path, error);

  revalidatePath(path);
  redirect(`${path}?contact=1`);
}

export async function addDeliverySite(formData: FormData) {
  const user = await getCurrentUser();
  const customerId = value(formData, "customerId", 36);
  const path = `/panel/clientes/${customerId}`;

  if (!canManageCustomers(user.roles)) failure(path, "No tienes permiso para agregar obras o direcciones.");
  if (!isUuid(customerId)) failure("/panel/clientes", "Cliente inválido.");

  const name = value(formData, "name", 150);
  const address = value(formData, "address", 500);
  const municipality = value(formData, "municipality", 100);
  const department = value(formData, "department", 100);
  const deliveryNotes = value(formData, "deliveryNotes", 800);
  const latitude = coordinate(formData, "latitude");
  const longitude = coordinate(formData, "longitude");

  if (!name || !address) failure(path, "El nombre y la dirección de entrega son obligatorios.");
  if (latitude === null || longitude === null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    failure(path, "Selecciona un pin válido en el mapa para guardar la ubicación.");
  }

  const supabase = await createClient();
  const { error } = await supabase.from("delivery_sites").insert({
    customer_id: customerId,
    name,
    address,
    municipality: municipality || null,
    department: department || null,
    delivery_notes: deliveryNotes || null,
    latitude,
    longitude,
  });

  if (error) databaseError(path, error);

  revalidatePath(path);
  redirect(`${path}?site=1`);
}

export async function updateCustomerDiscount(formData: FormData) {
  const user = await getCurrentUser();
  const customerId = value(formData, "customerId", 36);
  const path = `/panel/clientes/${customerId}`;

  if (!user.roles.includes("admin")) failure(path, "Sólo un administrador puede cambiar el descuento autorizado.");
  if (!isUuid(customerId)) failure("/panel/clientes", "Cliente inválido.");

  const discount = Number(value(formData, "authorizedDiscountPercentage", 10));
  if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
    failure(path, "El descuento debe ser un porcentaje entre 0 y 100.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("customers")
    .update({ authorized_discount_percentage: discount })
    .eq("id", customerId);

  if (error) databaseError(path, error);

  revalidatePath(path);
  redirect(`${path}?discount=1`);
}

export async function updateCustomerSeller(formData: FormData) {
  const user = await getCurrentUser();
  const customerId = value(formData, "customerId", 36);
  const sellerId = value(formData, "sellerId", 36);
  const path = `/panel/clientes/${customerId}`;

  if (!user.roles.includes("admin")) failure(path, "Sólo un administrador puede asignar o reasignar vendedores.");
  if (!isUuid(customerId) || (sellerId && !isUuid(sellerId))) failure(path, "La asignación no es válida.");

  const supabase = await createClient();
  const { error } = await supabase.from("customers").update({ assigned_seller_id: sellerId || null }).eq("id", customerId);
  if (error) databaseError(path, error);

  revalidatePath("/panel/clientes");
  revalidatePath(path);
  redirect(`${path}?seller=1`);
}

export async function addCustomerFollowUp(formData: FormData) {
  const user = await getCurrentUser();
  const customerId = value(formData, "customerId", 36);
  const path = `/panel/clientes/${customerId}`;
  const followUpType = value(formData, "followUpType", 20);
  const notes = value(formData, "notes", 1200);
  const nextFollowUpDate = value(formData, "nextFollowUpDate", 10);
  const allowedTypes = ["call", "whatsapp", "email", "visit", "other"];

  if (!canManageCustomers(user.roles)) failure(path, "No tienes permiso para registrar seguimientos.");
  if (!isUuid(customerId) || !allowedTypes.includes(followUpType) || !notes) {
    failure(path, "Completa el tipo y la nota del seguimiento.");
  }
  if (nextFollowUpDate && !/^\d{4}-\d{2}-\d{2}$/.test(nextFollowUpDate)) {
    failure(path, "La fecha del próximo seguimiento no es válida.");
  }

  const supabase = await createClient();
  const { data: customer } = await supabase.from("customers").select("assigned_seller_id").eq("id", customerId).maybeSingle();
  if (user.roles.includes("seller") && customer?.assigned_seller_id && customer.assigned_seller_id !== user.id) {
    failure(path, "Este cliente está asignado a otro vendedor.");
  }
  const { error } = await supabase.from("customer_follow_ups").insert({
    customer_id: customerId,
    seller_id: user.id,
    follow_up_type: followUpType,
    notes,
    next_follow_up_date: nextFollowUpDate || null,
  });
  if (error) databaseError(path, error);

  revalidatePath("/panel/clientes");
  revalidatePath(path);
  redirect(`${path}?followup=1`);
}
