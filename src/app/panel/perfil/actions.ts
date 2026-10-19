"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

function value(formData: FormData, name: string, maxLength: number) {
  const item = formData.get(name);
  return typeof item === "string" ? item.trim().slice(0, maxLength) : "";
}

export async function updateMyContactDetails(formData: FormData) {
  await getCurrentUser();
  const phone = value(formData, "phone", 40);
  const workplaceAddress = value(formData, "workplaceAddress", 250);
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_my_contact_details", {
    p_phone: phone,
    p_workplace_address: workplaceAddress,
  });

  if (error) redirect("/panel/perfil?error=No%20fue%20posible%20guardar%20tus%20datos.");
  revalidatePath("/panel/perfil");
  redirect("/panel/perfil?saved=1");
}
