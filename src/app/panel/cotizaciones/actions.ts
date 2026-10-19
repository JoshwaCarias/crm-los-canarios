"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

function value(formData: FormData, name: string, maxLength = 2000) {
  const item = formData.get(name);
  return typeof item === "string" ? item.trim().slice(0, maxLength) : "";
}

function isUuid(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function isNonNegativeAmount(amount: string) {
  const parsed = Number(amount);
  return Number.isFinite(parsed) && parsed >= 0;
}

function returnedQuoteId(data: unknown): string | null {
  const candidate = typeof data === "string"
    ? data
    : Array.isArray(data)
      ? data[0]?.create_quote ?? data[0]?.id
      : data && typeof data === "object"
        ? (data as Record<string, unknown>).create_quote ?? (data as Record<string, unknown>).id
        : null;

  return typeof candidate === "string" && isUuid(candidate) ? candidate : null;
}

function failure(message: string): never {
  redirect(`/panel/cotizaciones/nueva?error=${encodeURIComponent(message)}`);
}

function editFailure(quoteId: string, message: string): never {
  redirect(`/panel/cotizaciones/${quoteId}/editar?error=${encodeURIComponent(message)}`);
}

function detailFailure(quoteId: string, message: string): never {
  redirect(`/panel/cotizaciones/${quoteId}?error=${encodeURIComponent(message)}`);
}

export async function createQuote(formData: FormData) {
  const user = await getCurrentUser();
  if (!hasAnyRole(user.roles, ["seller", "admin", "manager"])) {
    failure("No tienes permiso para crear cotizaciones.");
  }

  const customerId = value(formData, "customerId", 36);
  const deliverySiteId = value(formData, "deliverySiteId", 36);
  const paymentTerms = value(formData, "paymentTerms", 120);
  const deliveryTerms = value(formData, "deliveryTerms", 300);
  const notes = value(formData, "notes", 1200);
  const rawItems = value(formData, "items", 20000);
  const freightAmount = value(formData, "freightAmount", 30) || "0";

  if (!isUuid(customerId)) failure("Selecciona un cliente válido.");
  if (deliverySiteId && !isUuid(deliverySiteId)) failure("La dirección de entrega no es válida.");
  if (!isNonNegativeAmount(freightAmount)) failure("El valor del flete debe ser igual o mayor a cero.");

  let items: unknown;
  try {
    items = JSON.parse(rawItems);
  } catch {
    failure("Agrega al menos un producto válido a la cotización.");
  }

  if (!Array.isArray(items) || items.length === 0) {
    failure("Agrega al menos un producto a la cotización.");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_quote", {
    p_customer_id: customerId,
    p_delivery_site_id: deliverySiteId || null,
    p_payment_terms: paymentTerms,
    p_delivery_terms: deliveryTerms,
    p_notes: notes,
    p_items: items,
    p_freight_amount: Number(freightAmount),
  });

  const quoteId = returnedQuoteId(data);
  if (error || !quoteId) {
    const message = error?.message?.includes("descuento")
      ? error.message
      : error?.message?.includes("asignado")
        ? error.message
        : "No fue posible emitir la cotización. Verifica sus productos y vuelve a intentarlo.";
    failure(message);
  }

  revalidatePath("/panel/cotizaciones");
  revalidatePath(`/panel/clientes/${customerId}`);
  redirect(`/panel/cotizaciones/${quoteId}`);
}

export async function updateQuote(formData: FormData) {
  const user = await getCurrentUser();
  const quoteId = value(formData, "quoteId", 36);
  if (!isUuid(quoteId)) {
    redirect("/panel/cotizaciones");
  }
  if (!hasAnyRole(user.roles, ["seller", "admin", "manager"])) {
    editFailure(quoteId, "No tienes permiso para modificar cotizaciones.");
  }

  const customerId = value(formData, "customerId", 36);
  const deliverySiteId = value(formData, "deliverySiteId", 36);
  const paymentTerms = value(formData, "paymentTerms", 120);
  const deliveryTerms = value(formData, "deliveryTerms", 300);
  const notes = value(formData, "notes", 1200);
  const rawItems = value(formData, "items", 20000);
  const freightAmount = value(formData, "freightAmount", 30) || "0";

  if (!isUuid(customerId)) editFailure(quoteId, "Selecciona un cliente válido.");
  if (deliverySiteId && !isUuid(deliverySiteId)) editFailure(quoteId, "La dirección de entrega no es válida.");
  if (!isNonNegativeAmount(freightAmount)) editFailure(quoteId, "El valor del flete debe ser igual o mayor a cero.");

  let items: unknown;
  try {
    items = JSON.parse(rawItems);
  } catch {
    editFailure(quoteId, "Agrega al menos un producto válido a la cotización.");
  }
  if (!Array.isArray(items) || items.length === 0) {
    editFailure(quoteId, "Agrega al menos un producto a la cotización.");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_quote", {
    p_quote_id: quoteId,
    p_customer_id: customerId,
    p_delivery_site_id: deliverySiteId || null,
    p_payment_terms: paymentTerms,
    p_delivery_terms: deliveryTerms,
    p_notes: notes,
    p_items: items,
    p_freight_amount: Number(freightAmount),
  });

  if (error) {
    editFailure(quoteId, error.message || "No fue posible actualizar la cotización.");
  }

  revalidatePath("/panel/cotizaciones");
  revalidatePath(`/panel/cotizaciones/${quoteId}`);
  revalidatePath(`/panel/clientes/${customerId}`);
  redirect(`/panel/cotizaciones/${quoteId}?notice=${encodeURIComponent("Cotización actualizada y enviada nuevamente a aprobación administrativa.")}`);
}

export async function transitionQuoteStatus(formData: FormData) {
  await getCurrentUser();
  const quoteId = value(formData, "quoteId", 36);
  const nextStatus = value(formData, "nextStatus", 80);
  const reason = value(formData, "reason", 1200);
  if (!isUuid(quoteId) || !nextStatus) {
    redirect("/panel/cotizaciones");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("transition_quote_status", {
    p_quote_id: quoteId,
    p_next_status: nextStatus,
    p_reason: reason || null,
  });

  if (error) {
    detailFailure(quoteId, error.message || "No fue posible cambiar el estado de la cotización.");
  }

  revalidatePath("/panel/cotizaciones");
  revalidatePath(`/panel/cotizaciones/${quoteId}`);
  redirect(`/panel/cotizaciones/${quoteId}?notice=${encodeURIComponent("Estado actualizado correctamente.")}`);
}
