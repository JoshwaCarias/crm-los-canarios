import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { quoteStatusLabel } from "@/lib/quote-workflow";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

type Quote = { id: string; quote_number: string; customer_id: string; seller_id: string; status: string; issue_date: string; total: number | string; payment_terms: string };
type Customer = { id: string; legal_name: string };
type Profile = { id: string; full_name: string };

const money = new Intl.NumberFormat("es-GT", { style: "currency", currency: "GTQ" });
const date = new Intl.DateTimeFormat("es-GT", { dateStyle: "medium", timeZone: "America/Guatemala" });

export default async function QuotesPage() {
  const [user, supabase] = await Promise.all([getCurrentUser(), createClient()]);
  const userIsOnlySeller = user.roles.includes("seller") && !hasAnyRole(user.roles, ["admin", "manager"]);
  let quoteQuery = supabase.from("quotes").select("id, quote_number, customer_id, seller_id, status, issue_date, total, payment_terms").order("created_at", { ascending: false }).limit(100);
  if (userIsOnlySeller) quoteQuery = quoteQuery.eq("seller_id", user.id);
  const { data } = await quoteQuery;
  const quotes = (data ?? []) as Quote[];
  const customerIds = [...new Set(quotes.map((quote) => quote.customer_id))];
  const sellerIds = [...new Set(quotes.map((quote) => quote.seller_id))];
  const [customersResult, sellersResult] = await Promise.all([
    customerIds.length ? supabase.from("customers").select("id, legal_name").in("id", customerIds) : Promise.resolve({ data: [] as Customer[] }),
    sellerIds.length ? supabase.from("profiles").select("id, full_name").in("id", sellerIds) : Promise.resolve({ data: [] as Profile[] }),
  ]);
  const customerNames = new Map(((customersResult.data ?? []) as Customer[]).map((customer) => [customer.id, customer.legal_name]));
  const sellerNames = new Map(((sellersResult.data ?? []) as Profile[]).map((seller) => [seller.id, seller.full_name]));

  return (
    <div className="module-page">
      <section className="module-header">
        <div><p className="eyebrow">VENTAS · DOCUMENTOS COMERCIALES</p><h3>Cotizaciones</h3><p>Precios, descuento autorizado y condiciones comerciales entregadas al cliente.</p></div>
        <Link className="button-link" href="/panel/cotizaciones/nueva">Nueva cotización</Link>
      </section>
      {quotes.length === 0 ? <div className="empty-card">Aún no hay cotizaciones emitidas.</div> : (
        <div className="table-card"><table><thead><tr><th>Correlativo</th><th>Cliente</th><th>Vendedor</th><th>Fecha</th><th>Pago</th><th>Estado</th><th>Total</th><th /></tr></thead><tbody>
          {quotes.map((quote) => <tr key={quote.id}><td><strong>{quote.quote_number}</strong></td><td>{customerNames.get(quote.customer_id) ?? "Cliente no disponible"}</td><td>{sellerNames.get(quote.seller_id) ?? "—"}</td><td>{date.format(new Date(`${quote.issue_date}T12:00:00`))}</td><td>{quote.payment_terms}</td><td><span className={`status-pill quote-status-${quote.status}`}>{quoteStatusLabel(quote.status)}</span></td><td><strong>{money.format(Number(quote.total))}</strong></td><td><Link className="text-link" href={`/panel/cotizaciones/${quote.id}`}>Ver, flujo e imprimir</Link></td></tr>)}
        </tbody></table></div>
      )}
    </div>
  );
}
