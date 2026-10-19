export const APP_ROLES = [
  "seller",
  "dispatch",
  "warehouse",
  "plant",
  "accounting",
  "admin",
  "manager",
] as const;

export type AppRole = (typeof APP_ROLES)[number];

export const ROLE_DETAILS: Record<AppRole, { label: string; summary: string }> = {
  seller: {
    label: "Vendedor",
    summary: "Clientes, cotizaciones, pedidos y seguimiento comercial.",
  },
  dispatch: {
    label: "Despacho",
    summary: "Reservas, planificación de fletes, carga y evidencia de entrega.",
  },
  warehouse: {
    label: "Bodega",
    summary: "Materia prima, existencias y consulta del proceso de fabricación.",
  },
  plant: {
    label: "Planta",
    summary: "Producción, calidad, producto terminado e inventario operativo.",
  },
  accounting: {
    label: "Contabilidad",
    summary: "Crédito, facturación, cobros y cuentas por cobrar.",
  },
  admin: {
    label: "Administrador",
    summary: "Configuración, usuarios, permisos y auditoría del sistema.",
  },
  manager: {
    label: "Gerencia",
    summary: "Indicadores, autorizaciones y supervisión integral del negocio.",
  },
};

export function hasAnyRole(roles: AppRole[], expected: AppRole[]) {
  return expected.some((role) => roles.includes(role));
}
