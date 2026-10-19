"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

function text(formData: FormData, name: string, max = 1200) { const value = formData.get(name); return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function uuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function fail(message: string): never { redirect(`/panel/finanzas?error=${encodeURIComponent(message)}`); }
function checkRole(roles: Awaited<ReturnType<typeof getCurrentUser>>["roles"]) { return hasAnyRole(roles, ["accounting", "admin", "manager"]); }

export async function createInvoice(formData: FormData) {
  const user = await getCurrentUser(); const deliveryGroupId = text(formData, "deliveryGroupId", 36);
  if (!checkRole(user.roles) || !uuid(deliveryGroupId)) fail("No tienes permiso o la entrega no es válida.");
  const supabase = await createClient(); const { data: invoiceId, error } = await supabase.rpc("create_invoice_from_delivery_group", { p_delivery_group_id: deliveryGroupId });
  if (error) fail(error.message || "No fue posible generar la factura.");
  revalidatePath("/panel/finanzas"); revalidatePath("/panel/pedidos"); revalidatePath("/panel");
  if (typeof invoiceId === "string" && uuid(invoiceId)) redirect(`/panel/finanzas/${invoiceId}?notice=${encodeURIComponent("Factura creada correctamente.")}`);
  redirect("/panel/finanzas?notice=Factura creada correctamente.");
}

export async function registerPayment(formData: FormData) {
  const user = await getCurrentUser(); const invoiceId = text(formData, "invoiceId", 36); const amount = Number(text(formData, "amount", 30)); const method = text(formData, "method", 30);
  if (!checkRole(user.roles) || !uuid(invoiceId) || !Number.isFinite(amount) || amount <= 0 || !['cash', 'bank_transfer', 'check', 'card', 'other'].includes(method)) fail("Verifica los datos del pago.");
  const supabase = await createClient(); const { error } = await supabase.rpc("register_invoice_payment", { p_invoice_id: invoiceId, p_method: method, p_amount: amount, p_reference: text(formData, "reference", 120) || null, p_notes: text(formData, "notes", 1200) || null });
  if (error) fail(error.message || "No fue posible registrar el pago.");
  revalidatePath("/panel/finanzas"); revalidatePath(`/panel/finanzas/${invoiceId}`); revalidatePath("/panel");
  redirect(`/panel/finanzas/${invoiceId}?notice=${encodeURIComponent("Pago registrado y crédito actualizado.")}`);
}
