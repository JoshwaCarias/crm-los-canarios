import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { canEditQuote } from "@/lib/quote-workflow";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

import { updateQuote } from "../../actions";
import { QuoteEditor } from "../../quote-editor";

type QuoteDetail = {
  quote: {
    id: string;
    customer_id: string;
    delivery_site_id: string | null;
    seller_id: string;
    status: string;
    payment_terms: string;
    delivery_terms: string;
    notes: string | null;
    freight_amount: number | string;
  };
  items: Array<{
    product_id: string;
    quantity: number | string;
    unit_price: number | string;
    discount_amount: number | string;
  }>;
};
type Customer = { id: string; legal_name: string; nit: string; authorized_discount_percentage: number | string; assigned_seller_id: string | null };
type DeliverySite = { id: string; customer_id: string; name: string; address: string };
type Product = { id: string; sku: string; name: string; description: string | null; unit: string };
type Availability = { product_id: string; available_quantity: number | string };

function percentageFromAmount(quantity: number | string, unitPrice: number | string, discountAmount: number | string) {
  const subtotal = Number(quantity) * Number(unitPrice);
  return subtotal > 0 ? ((Number(discountAmount) / subtotal) * 100).toFixed(2) : "0";
}

export default async function EditQuotePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, { error }, user, supabase] = await Promise.all([params, searchParams, getCurrentUser(), createClient()]);
  const { data, error: quoteError } = await supabase.rpc("get_quote_detail", { p_quote_id: id });
  const detail = data as QuoteDetail | null;

  if (quoteError || !detail?.quote) {
    redirect(`/panel/cotizaciones/${id}?error=${encodeURIComponent(quoteError?.message ?? "No fue posible cargar la cotización.")}`);
  }
  if (!canEditQuote(user.roles, detail.quote.status, detail.quote.seller_id, user.id)) {
    redirect(`/panel/cotizaciones/${id}?error=${encodeURIComponent("Esta cotización ya llegó a despacho, fue cerrada o no te pertenece.")}`);
  }

  const [customersResult, deliverySitesResult, productsResult, availabilityResult] = await Promise.all([
    supabase.from("customers").select("id, legal_name, nit, authorized_discount_percentage, assigned_seller_id").eq("is_active", true).order("legal_name"),
    supabase.from("delivery_sites").select("id, customer_id, name, address").eq("is_active", true).order("name"),
    supabase.from("products").select("id, sku, name, description, unit").eq("is_active", true).order("name"),
    supabase.rpc("get_product_availability"),
  ]);
  const isOnlySeller = user.roles.includes("seller") && !hasAnyRole(user.roles, ["admin", "manager"]);
  const customers = ((customersResult.data ?? []) as Customer[])
    .filter((customer) => !isOnlySeller || customer.id === detail.quote.customer_id || customer.assigned_seller_id === null || customer.assigned_seller_id === user.id)
    .map((customer) => ({
      id: customer.id,
      legalName: customer.legal_name,
      nit: customer.nit,
      authorizedDiscount: Number(customer.authorized_discount_percentage),
    }));
  const deliverySites = ((deliverySitesResult.data ?? []) as DeliverySite[])
    .map((site) => ({ id: site.id, customerId: site.customer_id, name: site.name, address: site.address }));
  const availabilityByProduct = new Map(((availabilityResult.data ?? []) as Availability[]).map((availability) => [availability.product_id, Number(availability.available_quantity)]));
  const products = ((productsResult.data ?? []) as Product[]).map((product) => ({ ...product, availableQuantity: availabilityByProduct.get(product.id) ?? 0 }));

  return (
    <div className="module-page">
      <div className="breadcrumb"><Link href="/panel/cotizaciones">Cotizaciones</Link><span>/</span><Link href={`/panel/cotizaciones/${id}`}>Detalle</Link><span>/</span><span>Modificar</span></div>
      <section className="module-header compact">
        <div>
          <p className="eyebrow">VENTAS · MODIFICAR COTIZACIÓN</p>
          <h3>Actualizar cotización</h3>
          <p>Al guardar, los importes se recalculan y el documento vuelve a aprobación administrativa.</p>
        </div>
      </section>
      {error && <p className="alert" role="alert">{error}</p>}
      <QuoteEditor
        customers={customers}
        deliverySites={deliverySites}
        products={products}
        action={updateQuote}
        submitLabel="Guardar y solicitar nueva aprobación"
        initialQuote={{
          id: detail.quote.id,
          customerId: detail.quote.customer_id,
          deliverySiteId: detail.quote.delivery_site_id ?? "",
          paymentTerms: detail.quote.payment_terms,
          deliveryTerms: detail.quote.delivery_terms,
          notes: detail.quote.notes ?? "",
          freightAmount: String(detail.quote.freight_amount),
          lines: detail.items.map((item) => ({
            productId: item.product_id,
            quantity: String(item.quantity),
            unitPrice: String(item.unit_price),
            discountPercentage: percentageFromAmount(item.quantity, item.unit_price, item.discount_amount),
          })),
        }}
      />
    </div>
  );
}
