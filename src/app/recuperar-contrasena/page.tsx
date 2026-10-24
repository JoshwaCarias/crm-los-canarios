"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";

// Se crea únicamente en el navegador.
// Desactivamos la lectura automática del enlace para verificarlo una sola vez.
function createRecoveryClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    throw new Error("Falta configurar Supabase.");
  }

  return createBrowserClient(url, key, {
    isSingleton: false,
    auth: {
      detectSessionInUrl: false,
      flowType: "pkce",
    },
  });
}

type RecoveryClient = ReturnType<typeof createRecoveryClient>;
type Mode = "loading" | "request" | "reset" | "invalid" | "done";

export default function RecoveryPage() {
  const client = useRef<RecoveryClient | null>(null);
  const initialized = useRef(false);
  const verifiedUser = useRef<string | null>(null);

  const [mode, setMode] = useState<Mode>("loading");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    async function initialize() {
      const query = new URLSearchParams(window.location.search);
      const hash = new URLSearchParams(window.location.hash.slice(1));

      const code = query.get("code");
      const accessToken = hash.get("access_token");
      const refreshToken = hash.get("refresh_token");
      const recoveryType = hash.get("type");

      const hasError = query.has("error") || hash.has("error");
      const hasCredentials =
        Boolean(code) ||
        Boolean(accessToken) ||
        Boolean(refreshToken) ||
        query.has("token_hash");

      // Retirar códigos y tokens de la barra de direcciones.
      if (hasError || hasCredentials) {
        window.history.replaceState(
          null,
          "",
          window.location.pathname
        );
      }

      try {
        const supabase = createRecoveryClient();
        client.current = supabase;

        if (hasError) {
          throw new Error("Enlace inválido.");
        }

        if (code) {
          // Enlace estándar para solicitudes realizadas desde este portal.
          const { data, error } =
            await supabase.auth.exchangeCodeForSession(code);

          if (error || !data.user) {
            throw new Error("No se pudo verificar el enlace.");
          }

          verifiedUser.current = data.user.id;
        } else if (
          recoveryType === "recovery" &&
          accessToken &&
          refreshToken
        ) {
          // Compatibilidad con enlaces estándar que contienen una sesión.
          const { data, error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });

          if (error || !data.user) {
            throw new Error("No se pudo verificar la sesión.");
          }

          verifiedUser.current = data.user.id;
        } else if (hasCredentials) {
          throw new Error("Formato de enlace no válido.");
        } else {
          setMode("request");
          return;
        }

        // Confirmar la identidad con el servicio de autenticación.
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (
          userError ||
          !user ||
          user.id !== verifiedUser.current
        ) {
          throw new Error("Sesión inválida.");
        }

        setMode("reset");
      } catch {
        verifiedUser.current = null;
        setError(
          "El enlace venció, ya fue utilizado o se abrió en otro " +
            "navegador. Solicita uno nuevo desde este portal y " +
            "ábrelo en el mismo navegador."
        );
        setMode("invalid");
      }
    }

    void initialize();
  }, []);

  async function requestRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const fields = new FormData(event.currentTarget);
    const email = String(fields.get("email") ?? "").trim();

    setBusy(true);

    try {
      const supabase = client.current;

      if (!supabase) {
        throw new Error("Servicio no disponible.");
      }

      const { error } = await supabase.auth.resetPasswordForEmail(
        email,
        {
          redirectTo:
            window.location.origin + "/recuperar-contrasena",
        }
      );

      if (error) {
        setError(
          "No se pudo procesar la solicitud. Espera unos minutos " +
            "e intenta nuevamente."
        );
        return;
      }

      setSent(true);
    } catch {
      setError(
        "No se pudo conectar con el servicio de autenticación."
      );
    } finally {
      setBusy(false);
    }
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const form = event.currentTarget;
    const fields = new FormData(form);
    const password = String(fields.get("password") ?? "");
    const confirmation = String(fields.get("confirmation") ?? "");

    if (password.length < 12) {
      setError("La contraseña debe tener al menos 12 caracteres.");
      return;
    }

    if (password !== confirmation) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    setBusy(true);

    try {
      const supabase = client.current;

      if (!supabase || !verifiedUser.current) {
        setMode("invalid");
        setError("Solicita un enlace de recuperación nuevo.");
        return;
      }

      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (
        userError ||
        !user ||
        user.id !== verifiedUser.current
      ) {
        verifiedUser.current = null;
        setMode("invalid");
        setError(
          "La sesión cambió o venció. Solicita un enlace nuevo."
        );
        return;
      }

      const { error: updateError } =
        await supabase.auth.updateUser({ password });

      if (updateError) {
        setError(
          "No se pudo actualizar. Usa una contraseña diferente, " +
            "de al menos 12 caracteres, que cumpla la política " +
            "de seguridad de la cuenta."
        );
        return;
      }

      form.reset();
      verifiedUser.current = null;

      // El cambio ya se realizó. Intentar cerrar las sesiones.
      try {
        await supabase.auth.signOut({ scope: "global" });
      } catch {
        // No presentar el cambio de contraseña como fallido
        // si únicamente falla el cierre de sesión.
      }

      setMode("done");
    } catch {
      setError(
        "No se pudo conectar. Revisa tu conexión e intenta nuevamente."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      className="login-panel"
      style={{ minHeight: "100vh" }}
    >
      <section className="login-card">
        <p className="eyebrow">LOS CANARIOS, S.A.</p>

        <h2>
          {mode === "reset"
            ? "Nueva contraseña"
            : "Recuperar contraseña"}
        </h2>

        {mode === "loading" && (
          <p role="status">Verificando enlace…</p>
        )}

        {mode === "request" && (
          <>
            <p className="muted">
              Ingresa el correo registrado en el CRM. Abre el
              correo de recuperación en este mismo navegador.
            </p>

            {sent ? (
              <p className="notice success" role="status">
                Si el correo está registrado, recibirás un enlace.
                Revisa también la carpeta de spam.
              </p>
            ) : (
              <form
                className="login-form"
                onSubmit={requestRecovery}
              >
                <label>
                  Correo electrónico
                  <input
                    name="email"
                    type="email"
                    autoComplete="email"
                    maxLength={254}
                    required
                  />
                </label>

                <button type="submit" disabled={busy}>
                  {busy ? "Enviando…" : "Enviar enlace"}
                </button>
              </form>
            )}
          </>
        )}

        {mode === "reset" && (
          <form className="login-form" onSubmit={savePassword}>
            <p className="muted">
              Escribe una contraseña nueva de al menos 12 caracteres.
              No recargues esta página antes de guardarla.
            </p>

            <label>
              Nueva contraseña
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
              />
            </label>

            <label>
              Confirmar contraseña
              <input
                name="confirmation"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
              />
            </label>

            <button type="submit" disabled={busy}>
              {busy ? "Guardando…" : "Guardar nueva contraseña"}
            </button>
          </form>
        )}

        {mode === "done" && (
          <p className="notice success" role="status">
            Contraseña actualizada. Ya puedes iniciar sesión
            con tu nueva contraseña.
          </p>
        )}

        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}

        {(mode === "invalid" || mode === "reset") && (
          <p>
            <a
              className="text-link"
              href="/recuperar-contrasena"
            >
              Solicitar un nuevo enlace
            </a>
          </p>
        )}

        <p>
          <Link className="text-link" href="/login">
            Volver a iniciar sesión
          </Link>
        </p>
      </section>
    </main>
  );
}
