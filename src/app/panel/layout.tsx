import Link from "next/link";

import { SignOutButton } from "@/app/auth/sign-out-button";
import { getCurrentUser } from "@/lib/auth";
import { APP_ROLES, ROLE_DETAILS, type AppRole } from "@/lib/roles";

const navigation: { href: string; label: string; roles: readonly AppRole[] }[] = [
  { href: "/panel", label: "Panel principal", roles: APP_ROLES },
  { href: "/panel/clientes", label: "Clientes", roles: ["seller", "accounting", "admin", "manager"] },
  { href: "/panel/productos", label: "Productos", roles: APP_ROLES },
  { href: "/panel/cotizaciones", label: "Cotizaciones", roles: ["seller", "dispatch", "plant", "admin", "manager"] },
  { href: "/panel/pedidos", label: "Pedidos", roles: APP_ROLES },
  { href: "/panel/produccion", label: "Producción e inventario", roles: ["plant", "warehouse", "dispatch", "admin", "manager"] },
  { href: "/panel/despachos", label: "Despachos", roles: ["dispatch", "admin", "manager"] },
  { href: "/panel/finanzas", label: "Finanzas", roles: ["accounting", "admin", "manager"] },
  { href: "/panel/reportes", label: "Reportes", roles: ["admin", "manager"] },
  { href: "/panel/alertas", label: "Alertas", roles: ["dispatch", "plant", "accounting", "admin", "manager"] },
  { href: "/panel/comercial", label: "Control comercial", roles: ["seller", "admin", "manager"] },
  { href: "/panel/importar", label: "Importar Excel", roles: ["admin"] },
  { href: "/panel/administracion", label: "Administración", roles: ["admin"] },
  { href: "/panel/perfil", label: "Mi perfil", roles: APP_ROLES },
];

export default async function PanelLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow sidebar-eyebrow">LOS CANARIOS, S.A.</p>
          <h1>CRM operativo</h1>
        </div>
        <nav aria-label="Navegación principal">
          {navigation.filter((item) => item.roles.some((role) => user.roles.includes(role))).map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
        </nav>
        <div className="sidebar-footer">
          <strong>{user.fullName}</strong>
          <small>{user.email}</small>
          <SignOutButton />
        </div>
      </aside>
      <main className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">PANEL PRINCIPAL</p>
            <h2>Área de trabajo</h2>
          </div>
          <div className="role-list" aria-label="Roles asignados">
            {user.roles.length > 0 ? (
              user.roles.map((role) => <span key={role}>{ROLE_DETAILS[role].label}</span>)
            ) : (
              <span>Sin rol asignado</span>
            )}
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
