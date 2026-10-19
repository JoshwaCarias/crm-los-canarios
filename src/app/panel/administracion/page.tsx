import { getCurrentUser } from "@/lib/auth";
import { APP_ROLES, ROLE_DETAILS, type AppRole } from "@/lib/roles";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { createSystemUser, deleteSystemUser, updateSystemUser } from "./actions";

type Profile = { id: string; full_name: string; is_active: boolean; created_at: string };
type UserRole = { user_id: string; role: AppRole };

const date = new Intl.DateTimeFormat("es-GT", { dateStyle: "medium", timeZone: "America/Guatemala" });

export default async function AdministrationPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const [currentUser, messages, supabase] = await Promise.all([getCurrentUser(), searchParams, createClient()]);
  if (!currentUser.roles.includes("admin")) {
    return <div className="module-page"><section className="module-header"><div><p className="eyebrow">ADMINISTRACIÓN</p><h3>Usuarios y roles</h3><p>Sólo los administradores pueden gestionar cuentas.</p></div></section></div>;
  }

  const [profilesResult, rolesResult] = await Promise.all([
    supabase.from("profiles").select("id, full_name, is_active, created_at").order("full_name"),
    supabase.from("user_roles").select("user_id, role"),
  ]);
  const profiles = (profilesResult.data ?? []) as Profile[];
  const roles = (rolesResult.data ?? []) as UserRole[];
  const rolesByUser = new Map<string, AppRole[]>();
  for (const role of roles) rolesByUser.set(role.user_id, [...(rolesByUser.get(role.user_id) ?? []), role.role]);

  let emailByUser = new Map<string, string>();
  let serviceError = "";
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) serviceError = error.message;
    else emailByUser = new Map(data.users.map((user) => [user.id, user.email ?? "Sin correo"]));
  } catch (error) {
    serviceError = error instanceof Error ? error.message : "No se pudo leer Auth.";
  }

  return (
    <div className="module-page">
      <section className="module-header">
        <div>
          <p className="eyebrow">ADMINISTRACIÓN · ACCESOS</p>
          <h3>Usuarios y roles</h3>
          <p>Crea cuentas, cambia sus datos y define exactamente qué áreas puede usar cada persona.</p>
        </div>
      </section>

      {messages.error && <p className="alert" role="alert">{messages.error}</p>}
      {messages.notice && <p className="notice success" role="status">{messages.notice}</p>}

      {serviceError ? (
        <p className="alert" role="alert">{serviceError} Configura <code>SUPABASE_SERVICE_ROLE_KEY</code> sólo en variables privadas del servidor para habilitar la gestión de usuarios.</p>
      ) : (
        <section className="detail-section">
          <div className="section-heading"><h3>Crear usuario</h3><span>La contraseña se entrega de forma segura al nuevo usuario.</span></div>
          <form className="inline-form form-grid" action={createSystemUser}>
            <label>Nombre completo *<input name="fullName" maxLength={120} required /></label>
            <label>Correo corporativo o personal *<input name="email" type="email" maxLength={254} placeholder="nombre@empresa.com" required /></label>
            <label className="full-width">Contraseña temporal *<input name="password" type="password" minLength={12} maxLength={128} required /><small className="form-help">Puede ser Gmail, correo corporativo u otro dominio válido. Mínimo 12 caracteres.</small></label>
            <fieldset className="role-checkboxes full-width">
              <legend>Roles *</legend>
              {APP_ROLES.map((role) => <label key={role}><input type="checkbox" name="roles" value={role} /><span><strong>{ROLE_DETAILS[role].label}</strong><small>{ROLE_DETAILS[role].summary}</small></span></label>)}
            </fieldset>
            <button type="submit">Crear usuario</button>
          </form>
        </section>
      )}

      <section className="detail-section">
        <div className="section-heading"><h3>Usuarios existentes</h3><span>{profiles.length} perfiles</span></div>
        {serviceError ? <div className="empty-inline">Configura la clave privada del servidor para editar o eliminar cuentas.</div> : profiles.length === 0 ? <div className="empty-inline">No hay perfiles registrados.</div> : (
          <div className="user-list">
            {profiles.map((profile) => {
              const assigned = rolesByUser.get(profile.id) ?? [];
              const email = emailByUser.get(profile.id) ?? "";
              const isCurrentUser = profile.id === currentUser.id;
              return (
                <article className="user-card" key={profile.id}>
                  <form className="user-update-form" action={updateSystemUser}>
                    <input type="hidden" name="userId" value={profile.id} />
                    <div className="user-card-heading"><strong>{profile.full_name}</strong><small>Creado {date.format(new Date(profile.created_at))}</small></div>
                    <label>Nombre completo *<input name="fullName" maxLength={120} defaultValue={profile.full_name} required /></label>
                    <label>Correo *<input name="email" type="email" maxLength={254} defaultValue={email} placeholder="nombre@empresa.com" required /></label>
                    <label>Contraseña nueva<input name="password" type="password" minLength={12} maxLength={128} placeholder="Dejar vacía para conservarla" /><small>Opcional; mínimo 12 caracteres si la cambias.</small></label>
                    <label className="user-active"><input type="checkbox" name="active" value="true" defaultChecked={profile.is_active} /> Cuenta activa</label>
                    <fieldset className="role-checkboxes compact">
                      <legend>Roles *</legend>
                      {APP_ROLES.map((role) => <label key={role}><input type="checkbox" name="roles" value={role} defaultChecked={assigned.includes(role)} /> {ROLE_DETAILS[role].label}</label>)}
                    </fieldset>
                    <button type="submit" className="button-secondary">Guardar cambios</button>
                  </form>

                  {isCurrentUser ? <p className="user-protected">No puedes eliminar tu propia cuenta ni quitarte el rol de Administrador.</p> : (
                    <form className="user-delete-form" action={deleteSystemUser}>
                      <input type="hidden" name="userId" value={profile.id} />
                      <label>Para eliminar permanentemente, escribe <strong>ELIMINAR</strong><input name="confirmation" maxLength={20} placeholder="ELIMINAR" required /></label>
                      <button type="submit">Eliminar usuario</button>
                    </form>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
