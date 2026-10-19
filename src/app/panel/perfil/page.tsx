import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

import { updateMyContactDetails } from "./actions";

type Profile = { full_name: string; phone: string | null; workplace_address: string | null };

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const [user, supabase, messages] = await Promise.all([getCurrentUser(), createClient(), searchParams]);
  const { data } = await supabase.from("profiles").select("full_name, phone, workplace_address").eq("id", user.id).maybeSingle();
  const profile = data as Profile | null;

  return (
    <div className="module-page narrow-page">
      <section className="module-header compact"><div><p className="eyebrow">CUENTA · INFORMACIÓN COMERCIAL</p><h3>Mi perfil de vendedor</h3><p>Estos datos aparecen como información de contacto en las cotizaciones que emitas.</p></div></section>
      {messages.saved === "1" && <p className="notice success">Información de contacto actualizada.</p>}
      {messages.error && <p className="alert" role="alert">{messages.error}</p>}
      <form className="form-card" action={updateMyContactDetails}>
        <div className="form-grid"><label>Nombre<input value={profile?.full_name ?? user.fullName} disabled /></label><label>Correo<input value={user.email} disabled /></label><label>Teléfono de contacto<input name="phone" type="tel" maxLength={40} defaultValue={profile?.phone ?? ""} placeholder="3006-2441" /></label><label>Dirección o sede de trabajo<input name="workplaceAddress" maxLength={250} defaultValue={profile?.workplace_address ?? ""} placeholder="Km. 31.8 carretera Interamericana" /></label></div>
        <div className="form-actions"><button type="submit">Guardar información</button></div>
      </form>
    </div>
  );
}
