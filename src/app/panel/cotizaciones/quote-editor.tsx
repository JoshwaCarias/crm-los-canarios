"use client";

import { useMemo, useState } from "react";

type Customer = {
  id: string;
  legalName: string;
  nit: string;
  authorizedDiscount: number;
};

type DeliverySite = { id: string; customerId: string; name: string; address: string };
type Product = { id: string; sku: string; name: string; description: string | null; unit: string; availableQuantity: number };
type QuoteLine = { id: number; productId: string; quantity: string; unitPrice: string; discountPercentage: string };
type InitialQuote = {
  id: string;
  customerId: string;
  deliverySiteId: string;
  paymentTerms: string;
  deliveryTerms: string;
  notes: string;
  freightAmount: string;
  lines: Omit<QuoteLine, "id">[];
};

type QuoteEditorProps = {
  customers: Customer[];
  deliverySites: DeliverySite[];
  products: Product[];
  action: (formData: FormData) => void | Promise<void>;
  initialQuote?: InitialQuote;
  submitLabel?: string;
};

const money = new Intl.NumberFormat("es-GT", { style: "currency", currency: "GTQ" });

function numeric(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function QuoteEditor({ customers, deliverySites, products, action, initialQuote, submitLabel = "Emitir cotización" }: QuoteEditorProps) {
  const [customerId, setCustomerId] = useState(initialQuote?.customerId ?? "");
  const [deliverySiteId, setDeliverySiteId] = useState(initialQuote?.deliverySiteId ?? "");
  const [paymentTerms, setPaymentTerms] = useState(initialQuote?.paymentTerms ?? "Efectivo");
  const [deliveryTerms, setDeliveryTerms] = useState(initialQuote?.deliveryTerms ?? "Sujeto a existencias");
  const [notes, setNotes] = useState(initialQuote?.notes ?? "");
  const [freightAmount, setFreightAmount] = useState(initialQuote?.freightAmount ?? "0");
  const [lines, setLines] = useState<QuoteLine[]>(() => initialQuote?.lines.map((line, index) => ({ ...line, id: index + 1 })) ?? [{ id: 1, productId: "", quantity: "1", unitPrice: "", discountPercentage: "0" }]);
  const selectedCustomer = customers.find((customer) => customer.id === customerId);
  const customerSites = deliverySites.filter((site) => site.customerId === customerId);
  const discountLimit = selectedCustomer?.authorizedDiscount ?? 0;

  const totals = useMemo(() => lines.reduce(
    (total, line) => {
      const subtotal = numeric(line.quantity) * numeric(line.unitPrice);
      const discount = subtotal * Math.min(Math.max(numeric(line.discountPercentage), 0), discountLimit) / 100;
      return { subtotal: total.subtotal + subtotal, discount: total.discount + discount };
    },
    { subtotal: 0, discount: 0 },
  ), [lines, discountLimit]);
  const freight = Math.max(numeric(freightAmount), 0);
  const grandTotal = totals.subtotal - totals.discount + freight;

  function updateLine(id: number, key: keyof QuoteLine, nextValue: string) {
    setLines((current) => current.map((line) => line.id === id ? { ...line, [key]: nextValue } : line));
  }

  function addLine() {
    setLines((current) => [...current, {
      id: Math.max(0, ...current.map((line) => line.id)) + 1,
      productId: "",
      quantity: "1",
      unitPrice: "",
      discountPercentage: "0",
    }]);
  }

  function removeLine(id: number) {
    setLines((current) => current.length === 1 ? current : current.filter((line) => line.id !== id));
  }

  const itemPayload = JSON.stringify(lines
    .filter((line) => line.productId)
    .map((line) => ({
      productId: line.productId,
      quantity: numeric(line.quantity),
      unitPrice: numeric(line.unitPrice),
      discountPercentage: numeric(line.discountPercentage),
    })));

  return (
    <form className="quote-editor" action={action}>
      {initialQuote && <input type="hidden" name="quoteId" value={initialQuote.id} />}
      <section className="quote-editor-section">
        <div className="section-heading"><h4>Datos de cotización</h4><span>La fecha y el correlativo se generan al emitirla.</span></div>
        <div className="form-grid">
          <label className="full-width">Estimado / cliente *
            <select name="customerId" value={customerId} onChange={(event) => { setCustomerId(event.target.value); setDeliverySiteId(""); }} required>
              <option value="">Selecciona un cliente</option>
              {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.legalName} · NIT {customer.nit}</option>)}
            </select>
          </label>
          <label>Dirección de entrega
            <select name="deliverySiteId" value={deliverySiteId} onChange={(event) => setDeliverySiteId(event.target.value)} disabled={!customerId}>
              <option value="">Sin dirección definida</option>
              {customerSites.map((site) => <option key={site.id} value={site.id}>{site.name} · {site.address}</option>)}
            </select>
          </label>
          <label>Condiciones de pago *
            <select name="paymentTerms" value={paymentTerms} onChange={(event) => setPaymentTerms(event.target.value)} required>
              <option>Efectivo</option><option>Crédito</option><option>Transferencia bancaria</option><option>Cheque</option><option>Tarjeta / Visalink</option>
            </select>
          </label>
          <label className="full-width">Fecha / condición de entrega *
            <input name="deliveryTerms" value={deliveryTerms} onChange={(event) => setDeliveryTerms(event.target.value)} maxLength={300} required />
          </label>
          <label className="full-width">Notas adicionales
            <textarea name="notes" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1200} placeholder="Información especial para el cliente o despacho" />
          </label>
        </div>
        <div className="discount-limit">Descuento máximo autorizado para este cliente: <strong>{selectedCustomer ? `${discountLimit}%` : "Selecciona un cliente"}</strong></div>
      </section>

      <section className="quote-editor-section">
        <div className="section-heading"><h4>Productos y servicios</h4><button type="button" className="button-secondary" onClick={addLine}>Agregar línea</button></div>
        <div className="quote-lines">
          {lines.map((line, index) => {
            const selectedProduct = products.find((product) => product.id === line.productId);
            const lineSubtotal = numeric(line.quantity) * numeric(line.unitPrice);
            const lineDiscount = lineSubtotal * Math.min(Math.max(numeric(line.discountPercentage), 0), discountLimit) / 100;
            const requestedQuantity = numeric(line.quantity);
            const availableQuantity = selectedProduct?.availableQuantity ?? 0;
            const fromStock = Math.min(requestedQuantity, availableQuantity);
            const toProduce = Math.max(0, requestedQuantity - availableQuantity);
            return (
              <article className="quote-line" key={line.id}>
                <span className="line-number">{index + 1}</span>
                <label className="quote-product">Producto / servicio *
                  <select value={line.productId} onChange={(event) => updateLine(line.id, "productId", event.target.value)} required>
                    <option value="">Selecciona un producto</option>
                    {products.map((product) => <option key={product.id} value={product.id}>{product.sku} · {product.name}</option>)}
                  </select>
                  {selectedProduct && <><small>{selectedProduct.description ?? selectedProduct.name} · Unidad: {selectedProduct.unit}</small><span className="stock-availability"><span className="stock-available">Bodega: {fromStock.toLocaleString("es-GT", { maximumFractionDigits: 3 })}</span>{toProduce > 0 && <span className="stock-shortage">Fabricar: {toProduce.toLocaleString("es-GT", { maximumFractionDigits: 3 })}</span>}</span></>}
                </label>
                <label>Cantidad *<input type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event) => updateLine(line.id, "quantity", event.target.value)} required /></label>
                <label>Precio unitario (Q) *<input type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => updateLine(line.id, "unitPrice", event.target.value)} required /></label>
                <label>Descuento (%)<input type="number" min="0" max={discountLimit} step="0.01" value={line.discountPercentage} onChange={(event) => updateLine(line.id, "discountPercentage", event.target.value)} disabled={!selectedCustomer} /></label>
                <div className="line-total"><span>Total</span><strong>{money.format(lineSubtotal - lineDiscount)}</strong></div>
                <button type="button" className="remove-line" onClick={() => removeLine(line.id)} disabled={lines.length === 1}>Quitar</button>
              </article>
            );
          })}
        </div>
        <input type="hidden" name="items" value={itemPayload} />
        <div className="quote-totals">
          <span>Subtotal <strong>{money.format(totals.subtotal)}</strong></span>
          <span>Descuento de productos <strong>- {money.format(totals.discount)}</strong></span>
          <span>Productos con descuento <strong>{money.format(totals.subtotal - totals.discount)}</strong></span>
          <label className="freight-input">Flete estimado (Q)
            <input name="freightAmount" type="number" min="0" step="0.01" value={freightAmount} onChange={(event) => setFreightAmount(event.target.value)} required />
            <small>Referencia comercial. El flete facturable será el de cada entrega parcial.</small>
          </label>
          <span>Flete estimado (sin descuento) <strong>{money.format(freight)}</strong></span>
          <span className="quote-grand-total">Total estimado <strong>{money.format(grandTotal)}</strong></span>
        </div>
      </section>
      <div className="form-actions"><button type="submit">{submitLabel}</button></div>
    </form>
  );
}
