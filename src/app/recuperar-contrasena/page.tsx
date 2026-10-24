"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function RecoveryPage() {
  const token = useRef<string | null>(null);
  const verifiedUser = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [reset, setReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("token_hash")) {
      token.current = params.get("type") === "recovery" ? params.get("token_hash") : null;
      setReset(true);
      // Keep the one-use token in memory, not in browser history or subsequent URLs.
      window.history.replaceState(null, "", window.location.pathname);
    }
    setReady(true);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setError("");
    const password = String(fields.get("password") ?? "");
    if (reset && (password.length < 12 || password !== fields.get("confirm"))) {
      setError("Usa al menos 12 caracteres y confirma la misma contraseña.");
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      if (!reset) {
        const email = String(fields.get("email") ?? "").trim();
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + "/recuperar-contrasena",
        });
        if (error) { setError("No se pudo procesar la solicitud. Espera unos minutos y vuelve a intentar."); return; }
        setSent(true);
        return;
      }
      // A normal signed-in session is not enough: require the recovery email token.
      if (!verifiedUser.current) {
        if (!token.current) { setError("Enlace inválido. Solicita un correo nuevo."); return; }
        const { data, error } = await supabase.auth.verifyOtp({ token_hash: token.current, type: "recovery" });
        if (error || !data.user) { setError("El enlace venció o ya fue utilizado. Solicita uno nuevo."); return; }
        verifiedUser.current = data.user.id;
        token.current = null;
      }
      const { data: { user }, error: sessionError } = await supabase.auth.getUser();
      if (sessionError || !user || user.id !== verifiedUser.current) {
        setError("La sesión de recuperación cambió o venció. Solicita otro enlace."); return;
      }
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError("No se pudo guardar. Usa una contraseña nueva que cumpla la política de seguridad. Si persiste, solicita otro enlace."); return;
      }
      form.reset();
      setDone(true);
      await supabase.auth.signOut({ scope: "global" });
    } catch { setError("No se pudo conectar con el servicio. Revisa tu conexión e intenta nuevamente."); }
    finally { setBusy(false); }
  }

  return <main className="login-panel" style={{ minHeight: "100vh" }}>
    <section className="login-card">
      <p className="eyebrow">LOS CANARIOS, S.A.</p>
      <h2>{reset ? "Nueva contraseña" : "Recuperar contraseña"}</h2>
      <p className="muted">{reset ? "Usa al menos 12 caracteres. No compartas tu enlace de recuperación." : "Ingresa el correo registrado en el CRM."}</p>
      {!ready ? <p role="status">Cargando…</p> : <form className="login-form" onSubmit={submit}>
        {done ? <p className="notice success" role="status">Contraseña actualizada. Inicia sesión con tu nueva contraseña.</p> : sent ? <p className="notice success" role="status">Si el correo está registrado, recibirás un enlace. Revisa también spam.</p> : <>
          {reset ? <>
            <label>Nueva contraseña<input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
            <label>Confirmar contraseña<input name="confirm" type="password" autoComplete="new-password" minLength={12} required /></label>
          </> : <label>Correo electrónico<input name="email" type="email" autoComplete="email" maxLength={254} required /></label>}
          <button disabled={busy}>{busy ? "Procesando…" : reset ? "Guardar nueva contraseña" : "Enviar enlace"}</button>
        </>}
        {error && <p className="alert" role="alert">{error}</p>}
        {reset && !done && <a className="text-link" href="/recuperar-contrasena">Solicitar un nuevo enlace</a>}
        <Link className="text-link" href="/login">Volver a iniciar sesión</Link>
      </form>}
    </section>
  </main>;
}
