import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole, ROLE_DETAILS } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

type Metric = {
  label: string;
  value: number;
  description: string;
};

type CountFilter = {
  field: string;
  values: string[];
};

async function countRows(table: string, filters: CountFilter[] = []): Promise<number> {
  const supabase = await createClient();
  let query = supabase.from(table).select("*", { count: "exact", head: true });

  for (const filter of filters) {
    query = filter.values.length === 1
      ? query.eq(filter.field, filter.values[0])
      : query.in(filter.field, filter.values);
  }

  const { count } = await query;
  return count ?? 0;
}

async function getMetrics(userId: string, roles: Awaited<ReturnType<typeof getCurrentUser>>["roles"]) {
  const metrics: Promise<Metric>[] = [];

  if (hasAnyRole(roles, ["seller", "admin", "manager"])) {
    metrics.push(
      countRows("quotes", [
        { field: "seller_id", values: [userId] },
        { field: "status", values: ["draft", "sent", "pending_admin_approval", "approved", "in_production"] },
      ]).then((value) => ({
        label: "Cotizaciones abiertas",
        value,
        description: "Pendientes de aprobación o en proceso comercial.",
      })),
      countRows("sales_orders", [
        { field: "seller_id", values: [userId] },
        { field: "status", values: ["approved", "pending_fulfillment"] },
      ]).then((value) => ({
        label: "Pedidos en proceso",
        value,
        description: "Pedidos aprobados aún sin completar.",
      })),
    );
  }

  if (hasAnyRole(roles, ["dispatch", "admin", "manager"])) {
    metrics.push(
      countRows("shipments", [
        { field: "status", values: ["planned", "loaded", "in_transit"] },
      ]).then((value) => ({
        label: "Despachos activos",
        value,
        description: "Cargas planificadas, cargadas o en ruta.",
      })),
    );
  }

  if (hasAnyRole(roles, ["plant", "admin", "manager"])) {
    metrics.push(
      countRows("production_batches", [
        { field: "production_date", values: [new Date().toISOString().slice(0, 10)] },
      ]).then((value) => ({
        label: "Lotes producidos hoy",
        value,
        description: "Registros de producción de la fecha actual.",
      })),
    );
  }

  if (hasAnyRole(roles, ["accounting", "admin", "manager"])) {
    metrics.push(
      countRows("invoices", [
        { field: "status", values: ["issued", "partially_paid"] },
      ]).then((value) => ({
        label: "Facturas por cobrar",
        value,
        description: "Documentos emitidos con saldo pendiente.",
      })),
    );
  }

  return Promise.all(metrics);
}

export default async function DashboardPage() {
  const user = await getCurrentUser();
  const metrics = await getMetrics(user.id, user.roles);
  const roleSummaries = user.roles.map((role) => ROLE_DETAILS[role]);

  return (
    <div className="dashboard-content">
      <section className="welcome-card">
        <div>
          <p className="eyebrow">SESIÓN ACTIVA</p>
          <h3>Hola, {user.fullName.split(" ")[0]}.</h3>
          <p>Consulta las prioridades de tu operación y conserva cada movimiento documentado.</p>
        </div>
        <div className="date-box">
          {new Intl.DateTimeFormat("es-GT", { dateStyle: "full", timeZone: "America/Guatemala" }).format(new Date())}
        </div>
      </section>

      <section aria-label="Resumen operativo">
        <div className="section-heading">
          <h3>Resumen operativo</h3>
          <span>Información según tus permisos</span>
        </div>
        {metrics.length > 0 ? (
          <div className="metric-grid">
            {metrics.map((metric) => (
              <article className="metric-card" key={metric.label}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <p>{metric.description}</p>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-card">
            No tienes un rol operativo asignado. Pide al administrador que actualice tu perfil.
          </div>
        )}
      </section>

      <section className="role-section">
        <div className="section-heading">
          <h3>Áreas habilitadas</h3>
          <span>Accesos y prioridades según los roles asignados.</span>
        </div>
        <div className="role-grid">
          {roleSummaries.map((role) => (
            <article className="role-card" key={role.label}>
              <h4>{role.label}</h4>
              <p>{role.summary}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
