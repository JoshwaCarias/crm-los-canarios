"use client";

import Link from "next/link";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

      if (signInError) {
        setError("No fue posible iniciar sesión. Revisa tu correo y contraseña.");
        return;
      }

      router.replace("/panel");
      router.refresh();
    } catch {
      setError("No se pudo conectar con el servicio de autenticación.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <label>
        Correo electrónico
        <input
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>
      <label>
        Contraseña
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>
      {error && <p className="alert" role="alert">{error}</p>}
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Ingresando…" : "Ingresar al CRM"}
      </button>
      <Link href="/recuperar-contrasena" className="text-link">Olvidé mi contraseña</Link>
    </form>
  );
}
