-- Pedido, producción, despacho, crédito, facturación y cobros.
-- Ejecutar después de 009_quote_freight.sql.

alter table public.customers
  add column if not exists credit_used numeric(14,2) not null default 0
  check (credit_used >= 0);

alter table public.sales_orders
  add column if not exists payment_terms text not null default 'Efectivo',
  add column if not exists credit_reserved_amount numeric(14,2) not null default 0
  check (credit_reserved_amount >= 0);

create sequence if not exists public.sales_order_number_seq start with 1000;
create sequence if not exists public.shipment_number_seq start with 1000;
create sequence if not exists public.invoice_number_seq start with 1000;

alter table public.sales_orders
  alter column order_number set default ('PED-' || lpad(nextval('public.sales_order_number_seq')::text, 6, '0'));
alter table public.shipments
  alter column shipment_number set default ('DES-' || lpad(nextval('public.shipment_number_seq')::text, 6, '0'));
alter table public.invoices
  alter column invoice_number set default ('FAC-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0'));

-- Una factura por pedido en este MVP. Las entregas parciales se agregarán al
-- módulo de facturación avanzada sin duplicar el documento actual.
create unique index if not exists invoices_sales_order_once_idx
  on public.invoices (sales_order_id)
  where sales_order_id is not null;

-- Al aprobar una cotización se crea o sincroniza su pedido. Si es a crédito,
-- se reserva el total completo (productos, descuentos y flete) contra el cupo.
create or replace function public.sync_order_from_quote_workflow()
returns trigger
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  order_record public.sales_orders%rowtype;
  credit_limit_value numeric(14,2);
  credit_used_value numeric(14,2);
  desired_credit_reserve numeric(14,2) := 0;
  reserve_difference numeric(14,2) := 0;
  quote_item record;
begin
  if new.status = 'approved'::public.quote_status
    and old.status is distinct from new.status then
    if lower(trim(new.payment_terms)) in ('crédito', 'credito') then
      desired_credit_reserve := new.total;
    end if;

    select * into order_record
    from public.sales_orders
    where quote_id = new.id;

    select credit_limit, credit_used
    into credit_limit_value, credit_used_value
    from public.customers
    where id = new.customer_id
    for update;

    if order_record.id is null then
      reserve_difference := desired_credit_reserve;
    else
      reserve_difference := desired_credit_reserve - order_record.credit_reserved_amount;
    end if;

    if reserve_difference > 0 and credit_used_value + reserve_difference > credit_limit_value then
      raise exception 'El cliente no tiene crédito disponible para aprobar este pedido. Disponible: Q %', credit_limit_value - credit_used_value;
    end if;

    if reserve_difference <> 0 then
      update public.customers
      set credit_used = greatest(0, credit_used + reserve_difference),
          updated_at = now()
      where id = new.customer_id;
    end if;

    if order_record.id is null then
      insert into public.sales_orders (
        quote_id, customer_id, delivery_site_id, seller_id, status,
        requested_delivery_date, credit_approved_by, credit_approved_at,
        currency, subtotal, discount_amount, tax_amount, total,
        freight_amount, payment_terms, credit_reserved_amount, notes
      ) values (
        new.id, new.customer_id, new.delivery_site_id, new.seller_id,
        'pending_fulfillment', null,
        case when desired_credit_reserve > 0 then auth.uid() else null end,
        case when desired_credit_reserve > 0 then now() else null end,
        new.currency, new.subtotal, new.discount_amount, new.tax_amount, new.total,
        new.freight_amount, new.payment_terms, desired_credit_reserve,
        coalesce(new.terms, 'Generado desde la cotización ' || new.quote_number)
      ) returning * into order_record;
    else
      update public.sales_orders
      set customer_id = new.customer_id,
          delivery_site_id = new.delivery_site_id,
          seller_id = new.seller_id,
          status = 'pending_fulfillment',
          subtotal = new.subtotal,
          discount_amount = new.discount_amount,
          tax_amount = new.tax_amount,
          total = new.total,
          freight_amount = new.freight_amount,
          payment_terms = new.payment_terms,
          credit_reserved_amount = desired_credit_reserve,
          credit_approved_by = case when desired_credit_reserve > 0 then auth.uid() else null end,
          credit_approved_at = case when desired_credit_reserve > 0 then now() else null end,
          notes = coalesce(new.terms, 'Actualizado desde la cotización ' || new.quote_number),
          updated_at = now()
      where id = order_record.id
      returning * into order_record;

      delete from public.sales_order_items where sales_order_id = order_record.id;
    end if;

    for quote_item in
      select * from public.quote_items where quote_id = new.id order by line_number
    loop
      insert into public.sales_order_items (
        sales_order_id, line_number, product_id, description, ordered_quantity,
        unit_price, discount_amount, tax_amount, line_total
      ) values (
        order_record.id, quote_item.line_number, quote_item.product_id,
        quote_item.description, quote_item.quantity, quote_item.unit_price,
        quote_item.discount_amount, quote_item.tax_amount, quote_item.line_total
      );
    end loop;

    insert into public.order_status_history (sales_order_id, previous_status, new_status, changed_by, reason)
    values (
      order_record.id,
      case when order_record.created_at = order_record.updated_at then null else 'pending_fulfillment'::public.sales_order_status end,
      'pending_fulfillment', auth.uid(),
      'Pedido generado o sincronizado desde ' || new.quote_number
    );
  elsif new.status = 'in_dispatch'::public.quote_status
    and old.status is distinct from new.status then
    update public.sales_orders
    set status = 'ready_for_dispatch', updated_at = now()
    where quote_id = new.id and status not in ('delivered', 'invoiced', 'closed', 'cancelled');
  elsif new.status = 'delivered'::public.quote_status
    and old.status is distinct from new.status then
    update public.sales_orders
    set status = 'delivered', updated_at = now()
    where quote_id = new.id and status not in ('invoiced', 'closed', 'cancelled');
  elsif new.status = 'cancelled'::public.quote_status
    and old.status is distinct from new.status then
    select * into order_record from public.sales_orders where quote_id = new.id;
    if order_record.id is not null and order_record.status not in ('delivered', 'invoiced', 'closed', 'cancelled') then
      if order_record.credit_reserved_amount > 0 then
        update public.customers
        set credit_used = greatest(0, credit_used - order_record.credit_reserved_amount),
            updated_at = now()
        where id = order_record.customer_id;
      end if;
      update public.sales_orders
      set status = 'cancelled', credit_reserved_amount = 0, updated_at = now()
      where id = order_record.id;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists quotes_sync_sales_order_workflow on public.quotes;
create trigger quotes_sync_sales_order_workflow
  after update of status on public.quotes
  for each row execute function public.sync_order_from_quote_workflow();

create or replace function public.record_production_batch(
  p_product_id uuid,
  p_location_id uuid,
  p_production_date date,
  p_shift text,
  p_quantity_produced numeric,
  p_quantity_rejected numeric,
  p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
  batch_id uuid;
  accepted_quantity numeric(14,3);
begin
  if current_user_id is null or not private.has_any_role(array['plant', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para registrar producción';
  end if;
  if p_quantity_produced is null or p_quantity_produced <= 0
    or coalesce(p_quantity_rejected, 0) < 0
    or coalesce(p_quantity_rejected, 0) > p_quantity_produced then
    raise exception 'Las cantidades de producción no son válidas';
  end if;
  if not exists (select 1 from public.products where id = p_product_id and is_active = true)
    or not exists (select 1 from public.inventory_locations where id = p_location_id and is_active = true) then
    raise exception 'El producto o la ubicación no están disponibles';
  end if;

  accepted_quantity := p_quantity_produced - coalesce(p_quantity_rejected, 0);
  insert into public.production_batches (
    batch_number, product_id, location_id, production_date, shift,
    quantity_produced, quantity_rejected, notes, created_by
  ) values (
    'LOT-' || to_char(coalesce(p_production_date, current_date), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 5),
    p_product_id, p_location_id, coalesce(p_production_date, current_date), nullif(trim(p_shift), ''),
    p_quantity_produced, coalesce(p_quantity_rejected, 0), nullif(trim(p_notes), ''), current_user_id
  ) returning id into batch_id;

  if accepted_quantity > 0 then
    insert into public.inventory_movements (
      movement_type, product_id, location_id, quantity, production_batch_id, notes, created_by
    ) values (
      'production', p_product_id, p_location_id, accepted_quantity, batch_id,
      'Ingreso automático por lote de producción', current_user_id
    );
  end if;
  return batch_id;
end;
$$;

create or replace function public.create_shipment(
  p_sales_order_id uuid,
  p_scheduled_at timestamptz,
  p_vehicle_id uuid,
  p_driver_id uuid,
  p_freight_cost numeric,
  p_freight_charge numeric,
  p_recipient_name text,
  p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
  order_record public.sales_orders%rowtype;
  shipment_id uuid;
  order_item record;
begin
  if current_user_id is null or not private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para programar despachos';
  end if;
  if p_scheduled_at is null or coalesce(p_freight_cost, 0) < 0 or coalesce(p_freight_charge, 0) < 0 then
    raise exception 'Completa una fecha de programación y montos de flete válidos';
  end if;
  select * into order_record from public.sales_orders where id = p_sales_order_id;
  if order_record.id is null or order_record.status <> 'ready_for_dispatch'::public.sales_order_status then
    raise exception 'El pedido no está autorizado para despacho';
  end if;
  if order_record.delivery_site_id is null then
    raise exception 'El pedido no tiene una dirección de entrega';
  end if;
  if p_vehicle_id is not null and not exists (select 1 from public.vehicles where id = p_vehicle_id and is_active = true) then
    raise exception 'El vehículo no está disponible';
  end if;
  if p_driver_id is not null and not exists (select 1 from public.drivers where id = p_driver_id and is_active = true) then
    raise exception 'El piloto no está disponible';
  end if;
  if exists (
    select 1 from public.shipment_items as shipment_item
    inner join public.shipments as shipment on shipment.id = shipment_item.shipment_id
    where shipment_item.sales_order_item_id in (select id from public.sales_order_items where sales_order_id = order_record.id)
      and shipment.status <> 'cancelled'::public.shipment_status
  ) then
    raise exception 'Este MVP permite un despacho activo por pedido';
  end if;

  insert into public.shipments (
    delivery_site_id, vehicle_id, driver_id, status, scheduled_at,
    freight_cost, freight_charge, recipient_name, delivery_notes, created_by
  ) values (
    order_record.delivery_site_id, p_vehicle_id, p_driver_id, 'planned', p_scheduled_at,
    coalesce(p_freight_cost, 0), coalesce(p_freight_charge, 0),
    nullif(trim(p_recipient_name), ''), nullif(trim(p_notes), ''), current_user_id
  ) returning id into shipment_id;

  for order_item in select * from public.sales_order_items where sales_order_id = order_record.id order by line_number
  loop
    insert into public.shipment_items (shipment_id, sales_order_item_id, loaded_quantity)
    values (shipment_id, order_item.id, order_item.ordered_quantity);
  end loop;
  return shipment_id;
end;
$$;

create or replace function public.advance_shipment_status(
  p_shipment_id uuid,
  p_next_status public.shipment_status,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
  shipment_record public.shipments%rowtype;
  quote_id_value uuid;
begin
  if current_user_id is null or not private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para actualizar despachos';
  end if;
  select * into shipment_record from public.shipments where id = p_shipment_id;
  if shipment_record.id is null then raise exception 'El despacho no existe'; end if;

  if shipment_record.status = 'planned'::public.shipment_status and p_next_status = 'loaded'::public.shipment_status then
    update public.shipments set status = p_next_status, loaded_at = now(), delivery_notes = coalesce(nullif(trim(p_notes), ''), delivery_notes) where id = p_shipment_id;
  elsif shipment_record.status = 'loaded'::public.shipment_status and p_next_status = 'in_transit'::public.shipment_status then
    select sales_order.quote_id into quote_id_value
    from public.shipment_items as shipment_item
    inner join public.sales_order_items as order_item on order_item.id = shipment_item.sales_order_item_id
    inner join public.sales_orders as sales_order on sales_order.id = order_item.sales_order_id
    where shipment_item.shipment_id = p_shipment_id
    limit 1;
    perform public.transition_quote_status(quote_id_value, 'in_route'::public.quote_status, coalesce(nullif(trim(p_notes), ''), 'Despacho salió a ruta'));
    update public.shipments set status = p_next_status, delivery_notes = coalesce(nullif(trim(p_notes), ''), delivery_notes) where id = p_shipment_id;
  elsif shipment_record.status = 'in_transit'::public.shipment_status and p_next_status = 'delivered'::public.shipment_status then
    select sales_order.quote_id into quote_id_value
    from public.shipment_items as shipment_item
    inner join public.sales_order_items as order_item on order_item.id = shipment_item.sales_order_item_id
    inner join public.sales_orders as sales_order on sales_order.id = order_item.sales_order_id
    where shipment_item.shipment_id = p_shipment_id
    limit 1;
    perform public.transition_quote_status(quote_id_value, 'delivered'::public.quote_status, coalesce(nullif(trim(p_notes), ''), 'Entrega confirmada desde despacho'));
    update public.shipments set status = p_next_status, delivered_at = now(), delivery_notes = coalesce(nullif(trim(p_notes), ''), delivery_notes) where id = p_shipment_id;
  else
    raise exception 'La transición de despacho no corresponde al estado actual';
  end if;
end;
$$;

create or replace function public.create_invoice_from_order(p_sales_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
  order_record public.sales_orders%rowtype;
  customer_days integer;
  invoice_id uuid;
  order_item record;
begin
  if current_user_id is null or not private.has_any_role(array['accounting', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para facturar';
  end if;
  select * into order_record from public.sales_orders where id = p_sales_order_id;
  if order_record.id is null or order_record.status <> 'delivered'::public.sales_order_status then
    raise exception 'El pedido debe estar entregado para facturarse';
  end if;
  if exists (select 1 from public.invoices where sales_order_id = order_record.id) then
    raise exception 'Este pedido ya tiene una factura';
  end if;
  select credit_days into customer_days from public.customers where id = order_record.customer_id;

  insert into public.invoices (
    customer_id, sales_order_id, status, issue_date, due_date, currency,
    subtotal, tax_amount, total, created_by
  ) values (
    order_record.customer_id, order_record.id, 'issued', current_date,
    current_date + case when lower(trim(order_record.payment_terms)) in ('crédito', 'credito') then customer_days else 0 end,
    order_record.currency, order_record.subtotal - order_record.discount_amount,
    order_record.tax_amount, order_record.total, current_user_id
  ) returning id into invoice_id;

  for order_item in select * from public.sales_order_items where sales_order_id = order_record.id order by line_number
  loop
    insert into public.invoice_items (invoice_id, description, quantity, unit_price, tax_amount, line_total)
    values (invoice_id, order_item.description, order_item.ordered_quantity, order_item.unit_price, order_item.tax_amount, order_item.line_total);
  end loop;
  if order_record.freight_amount > 0 then
    insert into public.invoice_items (invoice_id, description, quantity, unit_price, tax_amount, line_total)
    values (invoice_id, 'FLETE - Servicio de flete', 1, order_record.freight_amount, 0, order_record.freight_amount);
  end if;
  update public.sales_orders set status = 'invoiced', updated_at = now() where id = order_record.id;
  return invoice_id;
end;
$$;

create or replace function public.register_invoice_payment(
  p_invoice_id uuid,
  p_method public.payment_method,
  p_amount numeric,
  p_reference text,
  p_notes text
)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
  invoice_record public.invoices%rowtype;
  paid_before numeric(14,2);
  paid_after numeric(14,2);
  release_amount numeric(14,2);
  order_record public.sales_orders%rowtype;
begin
  if current_user_id is null or not private.has_any_role(array['accounting', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para registrar cobros';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount = 'NaN'::numeric then
    raise exception 'El pago debe ser mayor a cero';
  end if;
  select * into invoice_record from public.invoices where id = p_invoice_id;
  if invoice_record.id is null or invoice_record.status not in ('issued', 'partially_paid') then
    raise exception 'La factura no acepta nuevos pagos';
  end if;
  select coalesce(sum(amount), 0) into paid_before from public.payments where invoice_id = p_invoice_id;
  if paid_before + p_amount > invoice_record.total then
    raise exception 'El pago supera el saldo pendiente de la factura';
  end if;
  insert into public.payments (customer_id, invoice_id, method, amount, reference, notes, received_by)
  values (invoice_record.customer_id, p_invoice_id, p_method, p_amount, nullif(trim(p_reference), ''), nullif(trim(p_notes), ''), current_user_id);
  paid_after := paid_before + p_amount;
  update public.invoices set status = case when paid_after = invoice_record.total then 'paid'::public.invoice_status else 'partially_paid'::public.invoice_status end where id = p_invoice_id;

  if invoice_record.sales_order_id is not null then
    select * into order_record from public.sales_orders where id = invoice_record.sales_order_id;
    release_amount := least(p_amount, order_record.credit_reserved_amount);
    if release_amount > 0 then
      update public.customers set credit_used = greatest(0, credit_used - release_amount), updated_at = now() where id = invoice_record.customer_id;
      update public.sales_orders set credit_reserved_amount = credit_reserved_amount - release_amount, updated_at = now() where id = order_record.id;
    end if;
  end if;
end;
$$;

revoke all on function public.record_production_batch(uuid, uuid, date, text, numeric, numeric, text) from public;
grant execute on function public.record_production_batch(uuid, uuid, date, text, numeric, numeric, text) to authenticated;
revoke all on function public.create_shipment(uuid, timestamptz, uuid, uuid, numeric, numeric, text, text) from public;
grant execute on function public.create_shipment(uuid, timestamptz, uuid, uuid, numeric, numeric, text, text) to authenticated;
revoke all on function public.advance_shipment_status(uuid, public.shipment_status, text) from public;
grant execute on function public.advance_shipment_status(uuid, public.shipment_status, text) to authenticated;
revoke all on function public.create_invoice_from_order(uuid) from public;
grant execute on function public.create_invoice_from_order(uuid) to authenticated;
revoke all on function public.register_invoice_payment(uuid, public.payment_method, numeric, text, text) from public;
grant execute on function public.register_invoice_payment(uuid, public.payment_method, numeric, text, text) to authenticated;

notify pgrst, 'reload schema';
