import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { canEditQuote, quoteStatusLabel, quoteWorkflowActions, type QuoteWorkflowStatus } from "@/lib/quote-workflow";
import { createClient } from "@/lib/supabase/server";

import { transitionQuoteStatus } from "../actions";
import { PrintButton } from "../print-button";

type Quote = {
  id: string;
  quote_number: string;
  customer_id: string;
  delivery_site_id: string | null;
  seller_id: string;
  status: string;
  issue_date: string;
  valid_until: string | null;
  payment_terms: string;
  delivery_terms: string;
  notes: string | null;
  subtotal: number | string;
  discount_amount: number | string;
  freight_amount: number | string;
  total: number | string;
};
type Customer = { legal_name: string; nit: string };
type Seller = { full_name: string; phone: string | null; workplace_address: string | null };
type Site = { name: string; address: string };
type QuoteItem = {
  id: string;
  line_number: number;
  product_id: string;
  sku: string;
  description: string;
  quantity: number | string;
  unit_price: number | string;
  discount_amount: number | string;
  line_total: number | string;
};
type QuoteHistory = {
  id: string;
  previous_status: string | null;
  new_status: string;
  reason: string | null;
  changed_at: string;
  actor_name: string | null;
};
type QuoteDetail = {
  quote: Quote;
  customer: Customer | null;
  seller: Seller | null;
  site: Site | null;
  items: QuoteItem[];
  history?: QuoteHistory[];
};

const money = new Intl.NumberFormat("es-GT", { style: "currency", currency: "GTQ" });
const date = new Intl.DateTimeFormat("es-GT", { dateStyle: "medium", timeZone: "America/Guatemala" });
const dateTime = new Intl.DateTimeFormat("es-GT", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Guatemala" });
const workflowStages: QuoteWorkflowStatus[] = ["pending_admin_approval", "approved", "in_production", "pending_dispatch_authorization", "in_dispatch", "in_route", "delivered"];

export default async function QuoteDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string; error?: string }> }) {
  const [user, { id }, messages] = await Promise.all([getCurrentUser(), params, searchParams]);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_quote_detail", { p_quote_id: id });
  const detail = data as QuoteDetail | null;

  if (!detail?.quote) {
    return (
      <div className="module-page narrow-page">
        <section className="module-header compact">
          <div>
            <p className="eyebrow">COTIZACIONES</p>
            <h3>No fue posible abrir la cotización</h3>
            <p>{error?.message ?? "No encontramos el documento solicitado."}</p>
          </div>
        </section>
        <Link className="button-link" href="/panel/cotizaciones">Volver al listado de cotizaciones</Link>
      </div>
    );
  }

  const { quote, customer, seller, site, items, history = [] } = detail;
  const actions = quoteWorkflowActions(user.roles, quote.status, quote.seller_id, user.id);
  const mayEdit = canEditQuote(user.roles, quote.status, quote.seller_id, user.id);
  const currentStage = workflowStages.indexOf(quote.status as QuoteWorkflowStatus);

  return (
    <div className="module-page quote-page">
      <div className="quote-toolbar">
        <Link className="button-secondary button-link" href="/panel/cotizaciones">Volver a cotizaciones</Link>
        {mayEdit && <Link className="button-secondary button-link" href={`/panel/cotizaciones/${quote.id}/editar`}>Modificar</Link>}
        <PrintButton />
      </div>
      {messages.notice && <p className="notice success" role="status">{messages.notice}</p>}
      {messages.error && <p className="alert" role="alert">{messages.error}</p>}
      <section className="workflow-panel">
        <div className="workflow-heading">
          <div><p className="eyebrow">FLUJO OPERATIVO</p><h3>{quoteStatusLabel(quote.status)}</h3><p>La cotización no puede saltar pasos. Cada avance queda registrado con el usuario responsable.</p></div>
          {mayEdit && <span className="workflow-edit-note">Se puede modificar hasta antes de llegar a Despacho.</span>}
        </div>
        {quote.status === "cancelled" ? <p className="workflow-terminal">Esta cotización fue cancelada y quedó cerrada para cambios.</p> : (
          <ol className="workflow-timeline">
            {workflowStages.map((stage, index) => <li key={stage} className={currentStage >= index ? "complete" : ""}>{quoteStatusLabel(stage)}</li>)}
          </ol>
        )}
        {actions.length > 0 && <div className="workflow-actions">
          {actions.map((action) => (
            <form className={`workflow-action ${action.kind === "cancel" ? "workflow-action-cancel" : ""}`} action={transitionQuoteStatus} key={action.nextStatus}>
              <input type="hidden" name="quoteId" value={quote.id} />
              <input type="hidden" name="nextStatus" value={action.nextStatus} />
              <div><strong>{action.label}</strong><small>{action.description}</small></div>
              {action.needsReason && <label>Motivo *<textarea name="reason" rows={2} maxLength={1200} required placeholder="Explica por qué se cancela" /></label>}
              <button type="submit">{action.label}</button>
            </form>
          ))}
        </div>}
        <div className="workflow-history">
          <h4>Bitácora del proceso</h4>
          {history.length === 0 ? <p>No hay movimientos registrados para esta cotización todavía.</p> : <div className="workflow-history-list">
            {history.map((entry) => <article key={entry.id}><div><strong>{quoteStatusLabel(entry.new_status)}</strong>{entry.previous_status && <small>Desde: {quoteStatusLabel(entry.previous_status)}</small>}</div><p>{entry.reason ?? "Sin observaciones"}</p><small>{entry.actor_name ?? "Usuario no disponible"} · {dateTime.format(new Date(entry.changed_at))}</small></article>)}
          </div>}
        </div>
      </section>
      <article className="quote-document">
        <header className="quote-document-header">
          <div className="quote-pattern"><span /><span /><span /></div>
          <div className="quote-wordmark"><strong>LOS CANARIOS</strong><small>PREFABRICADOS DE CONCRETO</small></div>
        </header>
        <section className="quote-document-title"><h1>COTIZACIÓN</h1><span>Correlativo No. <strong>{quote.quote_number}</strong></span></section>
        <section className="quote-info-grid">
          <dl>
            <div><dt>Estimado:</dt><dd>{customer?.legal_name ?? "Cliente no disponible"}</dd></div>
            <div><dt>NIT:</dt><dd>{customer?.nit ?? "—"}</dd></div>
            <div><dt>Condiciones de pago:</dt><dd>{quote.payment_terms}</dd></div>
            <div><dt>Fecha de entrega:</dt><dd>{quote.delivery_terms}</dd></div>
          </dl>
          <dl>
            <div><dt>Fecha:</dt><dd>{date.format(new Date(`${quote.issue_date}T12:00:00`))}</dd></div>
            <div><dt>Vigencia:</dt><dd>{quote.valid_until ? date.format(new Date(`${quote.valid_until}T12:00:00`)) : "—"}</dd></div>
            {site && <div><dt>Entrega en:</dt><dd>{site.name} · {site.address}</dd></div>}
          </dl>
        </section>
        <table className="quote-document-table">
          <thead><tr><th>Código</th><th>Cant.</th><th>Descripción</th><th>Precio</th><th>Total</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.sku}</td>
                <td>{Number(item.quantity).toFixed(2)}</td>
                <td>{item.description}{Number(item.discount_amount) > 0 && <small>Descuento aplicado: {money.format(Number(item.discount_amount))}</small>}</td>
                <td>{money.format(Number(item.unit_price))}</td>
                <td>{money.format(Number(item.line_total))}</td>
              </tr>
            ))}
            {Number(quote.freight_amount) > 0 && <tr className="quote-freight-row"><td>FLETE EST.</td><td>1.00</td><td>Estimación de flete; se factura conforme a cada entrega parcial.</td><td>{money.format(Number(quote.freight_amount))}</td><td>{money.format(Number(quote.freight_amount))}</td></tr>}
          </tbody>
          <tfoot>
            <tr><td colSpan={4}>Subtotal de productos</td><td>{money.format(Number(quote.subtotal))}</td></tr>
            <tr><td colSpan={4}>Descuento de productos</td><td>- {money.format(Number(quote.discount_amount))}</td></tr>
            <tr><td colSpan={4}>Productos con descuento</td><td>{money.format(Number(quote.subtotal) - Number(quote.discount_amount))}</td></tr>
            <tr><td colSpan={4}>Flete estimado (sin descuento)</td><td>{money.format(Number(quote.freight_amount))}</td></tr>
            <tr className="document-total"><td colSpan={4}>TOTAL ESTIMADO</td><td>{money.format(Number(quote.total))}</td></tr>
          </tfoot>
        </table>
        {quote.notes && <p className="quote-notes"><strong>Notas:</strong> {quote.notes}</p>}
        <section className="quote-terms">
          <h3>NOTAS Y CONDICIONES</h3>
          <ul>
            <li>No se aceptan cambios ni devoluciones.</li>
            <li>El cliente confirma cantidades, dimensiones y tipo de producto antes de emitir el pedido.</li>
            <li>La descarga del camión y equipo necesario corresponde al cliente, según el producto.</li>
            <li>Los precios incluyen IVA y la cotización tiene vigencia de 10 días, salvo indicación distinta.</li>
            <li>Los pagos con tarjeta o Visalink pueden tener recargo según la política vigente.</li>
          </ul>
        </section>
        <footer className="quote-contact">
          <div>
            <span>Información de contacto</span>
            <strong>Teléfono: {seller?.phone ?? "No registrado"}</strong>
            <strong>Vendedor: {seller?.full_name ?? "No registrado"}</strong>
            <small>{seller?.workplace_address ?? "Los Canarios, S.A."}</small>
          </div>
          <div className="quote-footer-pattern"><span /><span /></div>
        </footer>
      </article>
    </div>
  );
}
