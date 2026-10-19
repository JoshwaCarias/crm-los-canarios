"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { APP_ROLES, type AppRole } from "@/lib/roles";
import { createAdminClient } from "@/lib/supabase/admin";

function text(formData: FormData, name: string, max = 300) { const value = formData.get(name); return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function uuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function validEmail(value: string) { return /^\S+@\S+\.\S+$/.test(value); }
function rolesFrom(formData: FormData) { return formData.getAll("roles").filter((role): role is AppRole => typeof role === "string" && APP_ROLES.includes(role as AppRole)); }
function fail(message: string): never { redirect(`/panel/administracion?error=${encodeURIComponent(message)}`); }
async function administrator() { const user = await getCurrentUser(); if (!user.roles.includes("admin")) fail("Sólo un administrador puede gestionar usuarios."); return user; }

export async function createSystemUser(formData: FormData) {
  await administrator();
  const fullName = text(formData, "fullName", 120); const email = text(formData, "email", 254).toLowerCase(); const password = text(formData, "password", 128); const roles = rolesFrom(formData);
  if (!fullName || !validEmail(email) || password.length < 12 || roles.length === 0) fail("Ingresa nombre, correo válido de cualquier dominio, contraseña de al menos 12 caracteres y un rol.");
  let admin;
  try { admin = createAdminClient(); } catch (error) { fail(error instanceof Error ? error.message : "No está configurada la clave privada de Supabase."); }
  const { data: authData, error: authError } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
  if (authError || !authData.user) fail(authError?.message || "No fue posible crear el usuario de autenticación.");
  const userId = authData.user.id;
  const { error: profileError } = await admin.from("profiles").upsert({ id: userId, full_name: fullName, is_active: true }, { onConflict: "id" });
  if (profileError) { await admin.auth.admin.deleteUser(userId); fail(profileError.message || "No fue posible crear el perfil."); }
  const { error: rolesError } = await admin.from("user_roles").upsert(roles.map((role) => ({ user_id: userId, role })), { onConflict: "user_id,role" });
  if (rolesError) { await admin.auth.admin.deleteUser(userId); fail(rolesError.message || "No fue posible asignar los roles."); }
  revalidatePath("/panel/administracion");
  redirect("/panel/administracion?notice=Usuario creado y roles asignados.");
}

export async function updateSystemUser(formData: FormData) {
  const currentUser = await administrator(); const userId = text(formData, "userId", 36); const fullName = text(formData, "fullName", 120); const email = text(formData, "email", 254).toLowerCase(); const password = text(formData, "password", 128); const roles = rolesFrom(formData); const active = text(formData, "active", 10) === "true";
  if (!uuid(userId) || !fullName || !validEmail(email) || roles.length === 0 || (password && password.length < 12)) fail("Verifica nombre, correo, roles y contraseña. La contraseña nueva es opcional, pero debe tener al menos 12 caracteres.");
  if (userId === currentUser.id && (!active || !roles.includes("admin"))) fail("No puedes desactivar tu propia cuenta ni quitarte el rol Administrador.");
  let admin;
  try { admin = createAdminClient(); } catch (error) { fail(error instanceof Error ? error.message : "No está configurada la clave privada de Supabase."); }
  const attributes: { email: string; email_confirm: boolean; user_metadata: { full_name: string }; password?: string } = { email, email_confirm: true, user_metadata: { full_name: fullName } };
  if (password) attributes.password = password;
  const { error: authError } = await admin.auth.admin.updateUserById(userId, attributes);
  if (authError) fail(authError.message || "No fue posible actualizar el acceso de autenticación.");
  const { error: profileError } = await admin.from("profiles").update({ full_name: fullName, is_active: active, updated_at: new Date().toISOString() }).eq("id", userId);
  if (profileError) fail(profileError.message || "No fue posible actualizar el usuario.");
  const { error: deleteError } = await admin.from("user_roles").delete().eq("user_id", userId);
  if (deleteError) fail(deleteError.message || "No fue posible actualizar los roles.");
  const { error: insertError } = await admin.from("user_roles").insert(roles.map((role) => ({ user_id: userId, role })));
  if (insertError) fail(insertError.message || "No fue posible asignar los nuevos roles.");
  revalidatePath("/panel/administracion"); revalidatePath("/panel");
  redirect("/panel/administracion?notice=Usuario actualizado.");
}

export async function deleteSystemUser(formData: FormData) {
  const currentUser = await administrator(); const userId = text(formData, "userId", 36); const confirmation = text(formData, "confirmation", 20).toUpperCase();
  if (!uuid(userId) || confirmation !== "ELIMINAR") fail("Para eliminar una cuenta escribe ELIMINAR como confirmación.");
  if (userId === currentUser.id) fail("No puedes eliminar tu propia cuenta. Asigna otro administrador para hacerlo.");
  let admin;
  try { admin = createAdminClient(); } catch (error) { fail(error instanceof Error ? error.message : "No está configurada la clave privada de Supabase."); }
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) fail(error.message || "No fue posible eliminar el usuario.");
  revalidatePath("/panel/administracion"); revalidatePath("/panel");
  redirect("/panel/administracion?notice=Usuario eliminado permanentemente.");
}
