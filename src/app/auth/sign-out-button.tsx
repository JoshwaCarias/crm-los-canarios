"use client";

import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <button className="sign-out" type="button" onClick={signOut}>
      Cerrar sesión
    </button>
  );
}
