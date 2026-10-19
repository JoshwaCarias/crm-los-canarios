"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { canManageProducts } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

function value(formData: FormData, name: string, maxLength = 500) {
  const item = formData.get(name);
  return typeof item === "string" ? item.trim().slice(0, maxLength) : "";
}

function failure(message: string): never {
  redirect(`/panel/productos/nuevo?error=${encodeURIComponent(message)}`);
}

function optionalNumber(formData: FormData, name: string, label: string) {
  const raw = value(formData, name, 30);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) failure(`${label} debe ser un número igual o mayor a cero.`);
  return parsed;
}

export async function createProduct(formData: FormData) {
  const user = await getCurrentUser();
  if (!canManageProducts(user.roles)) failure("No tienes permiso para crear productos.");

  const sku = value(formData, "sku", 60).toUpperCase();
  const name = value(formData, "name", 180);
  const description = value(formData, "description", 1000);
  const strengthClass = value(formData, "strengthClass", 80);
  const jointType = value(formData, "jointType", 80);
  const unit = value(formData, "unit", 30) || "unidad";
  const diameter = optionalNumber(formData, "diameterMm", "El diámetro");
  const length = optionalNumber(formData, "lengthMm", "La longitud");
  const weight = optionalNumber(formData, "weightKg", "El peso");

  if (!sku || !name) failure("El código y el nombre del producto son obligatorios.");

  const supabase = await createClient();
  const { error } = await supabase.from("products").insert({
    sku,
    name,
    description: description || null,
    diameter_mm: diameter,
    length_mm: length,
    strength_class: strengthClass || null,
    joint_type: jointType || null,
    unit,
    weight_kg: weight,
  });

  if (error) {
    const message = error.code === "23505"
      ? "Ya existe un producto con ese código."
      : "No fue posible guardar el producto. Intenta nuevamente.";
    failure(message);
  }

  revalidatePath("/panel/productos");
  redirect("/panel/productos?created=1");
}
