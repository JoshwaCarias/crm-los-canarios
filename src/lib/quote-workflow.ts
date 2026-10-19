import type { AppRole } from "@/lib/roles";

export type QuoteWorkflowStatus =
  | "draft"
  | "sent"
  | "accepted"
  | "rejected"
  | "expired"
  | "cancelled"
  | "pending_admin_approval"
  | "approved"
  | "in_production"
  | "pending_dispatch_authorization"
  | "in_dispatch"
  | "in_route"
  | "delivered";

type WorkflowAction = {
  nextStatus: QuoteWorkflowStatus;
  label: string;
  description: string;
  needsReason?: boolean;
  kind?: "cancel";
};

export const QUOTE_STATUS_LABELS: Record<QuoteWorkflowStatus, string> = {
  draft: "Borrador",
  sent: "Emitida",
  accepted: "Aceptada",
  rejected: "Rechazada",
  expired: "Vencida",
  cancelled: "Cancelada",
  pending_admin_approval: "Pendiente de aprobación",
  approved: "Aprobada · lista para fabricación",
  in_production: "En fabricación",
  pending_dispatch_authorization: "Pendiente de autorización de despacho",
  in_dispatch: "En despacho",
  in_route: "En ruta",
  delivered: "Entregada",
};

export function quoteStatusLabel(status: string) {
  return QUOTE_STATUS_LABELS[status as QuoteWorkflowStatus] ?? status;
}

export function canEditQuote(roles: AppRole[], status: string, sellerId: string, userId: string) {
  const beforeDispatch = ["pending_admin_approval", "approved", "in_production"].includes(status);
  const canManage = roles.includes("admin") || roles.includes("manager");
  return beforeDispatch && (canManage || (roles.includes("seller") && sellerId === userId));
}

export function quoteWorkflowActions(roles: AppRole[], status: string, sellerId: string, userId: string): WorkflowAction[] {
  const canManage = roles.includes("admin") || roles.includes("manager");
  const canPlant = roles.includes("plant") || canManage;
  const canDispatch = roles.includes("dispatch") || canManage;
  const isOwnSeller = roles.includes("seller") && sellerId === userId;
  const actions: WorkflowAction[] = [];

  if (status === "pending_admin_approval" && canManage) {
    actions.push({ nextStatus: "approved", label: "Aprobar para fabricación", description: "Autoriza condiciones, precio y descuento para iniciar fabricación." });
  }
  if (status === "approved" && canPlant) {
    actions.push({ nextStatus: "in_production", label: "Iniciar fabricación", description: "Planta asume la orden para preparar los productos." });
  }
  if (status === "in_production" && canPlant) {
    actions.push({ nextStatus: "pending_dispatch_authorization", label: "Enviar a autorización de despacho", description: "Producción terminó y solicita la revisión de Despacho." });
  }
  if (status === "pending_dispatch_authorization" && canDispatch) {
    actions.push({ nextStatus: "in_dispatch", label: "Autorizar y pasar a despacho", description: "Despacho valida que la carga puede prepararse y coordinarse." });
  }
  // La salida a ruta y la entrega se registran desde Despachos, porque allí
  // quedan ligadas al flete, vehículo, piloto y evidencia de entrega.

  const sellerMayCancel = isOwnSeller && status === "pending_admin_approval";
  const dispatchMayCancel = canDispatch && ["pending_dispatch_authorization", "in_dispatch"].includes(status);
  if (!["cancelled", "delivered"].includes(status) && (canManage || sellerMayCancel || dispatchMayCancel)) {
    actions.push({ nextStatus: "cancelled", label: "Cancelar cotización", description: "Requiere indicar el motivo y deja registro en la bitácora.", needsReason: true, kind: "cancel" });
  }

  return actions;
}
