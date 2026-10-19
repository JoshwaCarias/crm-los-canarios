import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

import { createQuote } from "../actions";
import { QuoteEditor } from "../quote-editor";

type Customer = { id: string; legal_name: string; nit: string; authorized_discount_percentage: number | string; assigned_seller_id: string | null };
type DeliverySite = { id: string; customer_id: string; name: string; address: string };
type Product = { id: string; sku: string; name: string; description: string | null; unit: string };
type Availability = { product_id: string; on_hand_quantity: number | string; reserved_quantity: number | string; available_quantity: number | string };

export default async function NewQuotePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const [user, supabase, { error }] = await Promise.all([getCurrentUser(), createClient(), searchParams]);
  const canCreate = hasAnyRole(user.roles, ["seller", "admin", "manager"]);
  const [customersResult, deliverySitesResult, productsResult, availabilityResult] = await Promise.all([
    supabase.from("customers").select("id, legal_name, nit, authorized_discount_percentage, assigned_seller_id").eq("is_active", true).order("legal_name"),
    supabase.from("delivery_sites").select("id, customer_id, name, address").eq("is_active", true).order("name"),
    supabase.from("products").select("id, sku, name, description, unit").eq("is_active", true).order("name"),
    supabase.rpc("get_product_availability"),
  ]);
  const isOnlySeller = user.roles.includes("seller") && !hasAnyRole(user.roles, ["admin", "manager"]);
  const customers = ((customersResult.data ?? []) as Customer[])
    .filter((customer) => !isOnlySeller || customer.assigned_seller_id === null || customer.assigned_seller_id === user.id)
    .map((customer) => ({ id: customer.id, legalName: customer.legal_name, nit: customer.nit, authorizedDiscount: Number(customer.authorized_discount_percentage) }));
  const deliverySites = ((deliverySitesResult.data ?? []) as DeliverySite[]).map((site) => ({ id: site.id, customerId: site.customer_id, name: site.name, address: site.address }));
  const availabilityByProduct = new Map(((availabilityResult.data ?? []) as Availability[]).map((availability) => [availability.product_id, Number(availability.available_quantity)]));
  const products = ((productsResult.data ?? []) as Product[]).map((product) => ({ ...product, availableQuantity: availabilityByProduct.get(product.id) ?? 0 }));

  return (
    <div className="module-page">
      <div className="breadcrumb"><Link href="/panel/cotizaciones">Cotizaciones</Link><span>/</span><span>Nueva cotización</span></div>
      <section className="module-header compact"><div><p className="eyebrow">VENTAS · NUEVA COTIZACIÓN</p><h3>Emitir cotización</h3><p>Consulta existencias en tiempo real; la reserva de bodega se realiza sólo al aprobar el pedido.</p></div></section>
      {error && <p className="alert" role="alert">{error}</p>}
      {!canCreate ? <div className="empty-card">No tienes permiso para emitir cotizaciones.</div> : customers.length === 0 ? <div className="empty-card">No hay clientes activos disponibles para cotizar.</div> : products.length === 0 ? <div className="empty-card">Registra al menos un producto antes de crear una cotización.</div> : <QuoteEditor customers={customers} deliverySites={deliverySites} products={products} action={createQuote} />}
    </div>
  );
}
