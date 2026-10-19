import { redirect } from "next/navigation";

import type { AppRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

export type CurrentUser = {
  id: string;
  email: string;
  fullName: string;
  roles: AppRole[];
};

export async function getCurrentUser(): Promise<CurrentUser> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [profileResult, rolesResult] = await Promise.all([
    supabase.from("profiles").select("full_name, is_active").eq("id", user.id).maybeSingle(),
    supabase.from("user_roles").select("role").eq("user_id", user.id),
  ]);

  if (!profileResult.data?.is_active) {
    redirect("/login?error=inactive");
  }

  const roles = (rolesResult.data ?? []).map((row) => row.role as AppRole);

  return {
    id: user.id,
    email: user.email ?? "sin correo",
    fullName: profileResult.data.full_name,
    roles,
  };
}
