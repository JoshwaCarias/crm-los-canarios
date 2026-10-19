"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

function text(formData: FormData, name: string, max = 500) { const value = formData.get(name); return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function validUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function fail(message: string): never { redirect(`/panel/comercial?error=${encodeURIComponent(message)}`); }

export async function saveSalesTarget(formData: FormData) {
  const user = await getCurrentUser();
  if (!hasAnyRole(user.roles, ["admin", "manager"])) fail("Sólo Administración o Gerencia puede definir metas.");
  const sellerId = text(formData, "sellerId", 36);
  const selectedMonth = text(formData, "targetMonth", 10);
  const targetMonth = /^\d{4}-\d{2}$/.test(selectedMonth) ? `${selectedMonth}-01` : selectedMonth;
  const salesTarget = Number(text(formData, "salesTarget", 30));
  const quoteTarget = Number(text(formData, "quoteTarget", 20));
  if (!validUuid(sellerId) || !/^\d{4}-\d{2}-01$/.test(targetMonth) || !Number.isFinite(salesTarget) || salesTarget < 0 || !Number.isInteger(quoteTarget) || quoteTarget < 0) fail("Verifica los datos de la meta.");
  const supabase = await createClient();
  const { error } = await supabase.from("sales_targets").upsert({ seller_id: sellerId, target_month: targetMonth, sales_target: salesTarget, quote_target: quoteTarget, notes: text(formData, "notes", 1200) || null, created_by: user.id, updated_at: new Date().toISOString() }, { onConflict: "seller_id,target_month" });
  if (error) fail(error.message || "No fue posible guardar la meta.");
  revalidatePath("/panel/comercial"); revalidatePath("/panel/reportes");
  redirect("/panel/comercial?notice=Meta comercial guardada.");
}
