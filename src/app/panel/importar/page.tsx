import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";

import { importWorkbook } from "./actions";

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const [user, messages] = await Promise.all([getCurrentUser(), searchParams]);
  const allowed = hasAnyRole(user.roles, ["admin"]);
  if (!allowed) return <div className="module-page"><section className="module-header"><div><p className="eyebrow">ADMINISTRACIÓN</p><h3>Importar información</h3><p>Sólo Administración puede importar información inicial.</p></div></section></div>;
  return <div className="module-page narrow-page"><section className="module-header"><div><p className="eyebrow">ADMINISTRACIÓN · CARGA INICIAL</p><h3>Importar desde Excel</h3><p>Importa clientes, productos, listas de precios y saldos de crédito con una plantilla validada.</p></div></section>{messages.error && <p className="alert" role="alert">{messages.error}</p>}{messages.notice && <p className="notice success" role="status">{messages.notice}</p>}
    <section className="detail-section"><h3>1. Descargar plantilla</h3><p className="form-help">No cambies los nombres de las hojas ni los encabezados. Puedes dejar vacías las hojas que no vayas a cargar.</p><a className="button-link" href="/plantillas/plantilla-importacion-crm.xlsx" download>Descargar plantilla Excel</a></section>
    <section className="detail-section"><h3>2. Cargar archivo</h3><form className="inline-form" action={importWorkbook}><label className="field-label" htmlFor="workbook">Archivo .xlsx (máximo 5 MB)</label><input id="workbook" name="workbook" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /><p className="form-help">El CRM valida formatos, columnas, duplicados, SKUs, listas de precio y límites de crédito durante la carga. Haz primero una prueba con una copia pequeña del archivo.</p><button type="submit">Validar e importar</button></form></section>
    <section className="detail-section"><h3>Hojas disponibles</h3><div className="record-list"><article><strong>Clientes</strong><p>Razón social, NIT, contacto y configuración de crédito.</p></article><article><strong>Productos</strong><p>SKU, dimensiones, clase, unión, peso y unidad.</p></article><article><strong>Precios</strong><p>Lista de precios, fechas de vigencia, SKU y precio unitario.</p></article><article><strong>Saldos iniciales</strong><p>Crédito utilizado por NIT. El saldo nunca puede exceder el límite autorizado.</p></article></div><p className="form-help">Para asignar cartera a vendedores, usa la ficha individual del cliente después de importar.</p></section>
    <Link className="text-link" href="/panel/clientes">Volver a clientes</Link>
  </div>;
}
