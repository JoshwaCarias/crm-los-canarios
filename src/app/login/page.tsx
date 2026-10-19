import { redirect } from "next/navigation";

import { LoginForm } from "./login-form";
import { createClient } from "@/lib/supabase/server";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/panel");
  }

  const { error } = await searchParams;

  return (
    <main className="login-shell">
      <section className="brand-panel">
        <span className="eyebrow">LOS CANARIOS, S.A.</span>
        <h1>CRM operativo</h1>
        <p>Ventas, planta, despacho y cartera conectados en un solo flujo.</p>
        <div className="brand-rule" />
        <p className="muted">Acceso exclusivo para personal autorizado.</p>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <p className="eyebrow">BIENVENIDO</p>
          <h2>Inicia sesión</h2>
          <p className="muted">Ingresa con el usuario asignado por administración.</p>
          {error === "inactive" && (
            <p className="alert" role="alert">
              Tu usuario no está activo. Contacta al administrador.
            </p>
          )}
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
