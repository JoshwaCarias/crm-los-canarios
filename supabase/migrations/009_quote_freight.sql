-- Flete comercial: forma parte de la cotización, del futuro pedido y de la
-- factura. El importe no recibe descuento y se suma al total final.
-- Ejecutar después de 008_quote_workflow.sql.

alter table public.quotes
  add column if not exists freight_amount numeric(14,2) not null default 0
  check (freight_amount >= 0);

-- El pedido conservará el flete autorizado desde la cotización cuando se
-- implemente la conversión a pedidos.
alter table public.sales_orders
  add column if not exists freight_amount numeric(14,2) not null default 0
  check (freight_amount >= 0);

-- Las funciones anteriores siguen existiendo como implementación interna;
-- se les retira acceso público para que todas las nuevas altas y ediciones
-- pasen el valor del flete y no puedan dejar el total desfasado.
revoke all on function public.create_quote(uuid, uuid, text, text, text, jsonb) from public;
revoke all on function public.create_quote(uuid, uuid, text, text, text, jsonb) from authenticated;
revoke all on function public.update_quote(uuid, uuid, uuid, text, text, text, jsonb) from public;
revoke all on function public.update_quote(uuid, uuid, uuid, text, text, text, jsonb) from authenticated;

create or replace function public.create_quote(
  p_customer_id uuid,
  p_delivery_site_id uuid,
  p_payment_terms text,
  p_delivery_terms text,
  p_notes text,
  p_items jsonb,
  p_freight_amount numeric
)
returns uuid
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  quote_id uuid;
  freight numeric(14,2);
begin
  if p_freight_amount is null
    or p_freight_amount = 'NaN'::numeric
    or p_freight_amount < 0 then
    raise exception 'El valor del flete debe ser un monto igual o mayor a cero';
  end if;

  freight := round(p_freight_amount, 2);
  select public.create_quote(
    p_customer_id,
    p_delivery_site_id,
    p_payment_terms,
    p_delivery_terms,
    p_notes,
    p_items
  ) into quote_id;

  update public.quotes
  set freight_amount = freight,
      total = round(subtotal - discount_amount + freight, 2),
      updated_at = now()
  where id = quote_id;

  return quote_id;
end;
$$;

create or replace function public.update_quote(
  p_quote_id uuid,
  p_customer_id uuid,
  p_delivery_site_id uuid,
  p_payment_terms text,
  p_delivery_terms text,
  p_notes text,
  p_items jsonb,
  p_freight_amount numeric
)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  freight numeric(14,2);
begin
  if p_freight_amount is null
    or p_freight_amount = 'NaN'::numeric
    or p_freight_amount < 0 then
    raise exception 'El valor del flete debe ser un monto igual o mayor a cero';
  end if;

  freight := round(p_freight_amount, 2);
  perform public.update_quote(
    p_quote_id,
    p_customer_id,
    p_delivery_site_id,
    p_payment_terms,
    p_delivery_terms,
    p_notes,
    p_items
  );

  update public.quotes
  set freight_amount = freight,
      total = round(subtotal - discount_amount + freight, 2),
      updated_at = now()
  where id = p_quote_id;
end;
$$;

revoke all on function public.create_quote(uuid, uuid, text, text, text, jsonb, numeric) from public;
grant execute on function public.create_quote(uuid, uuid, text, text, text, jsonb, numeric) to authenticated;
revoke all on function public.update_quote(uuid, uuid, uuid, text, text, text, jsonb, numeric) from public;
grant execute on function public.update_quote(uuid, uuid, uuid, text, text, text, jsonb, numeric) to authenticated;

create or replace function public.get_quote_detail(p_quote_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
  quote_record public.quotes%rowtype;
begin
  if current_user_id is null then
    raise exception 'Sesión no válida';
  end if;

  select * into quote_record
  from public.quotes
  where id = p_quote_id;

  if quote_record.id is null then
    raise exception 'Cotización no encontrada';
  end if;

  if quote_record.seller_id <> current_user_id
    and not private.has_any_role(array['dispatch', 'plant', 'accounting', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para abrir esta cotización';
  end if;

  return jsonb_build_object(
    'quote', jsonb_build_object(
      'id', quote_record.id,
      'quote_number', quote_record.quote_number,
      'customer_id', quote_record.customer_id,
      'delivery_site_id', quote_record.delivery_site_id,
      'seller_id', quote_record.seller_id,
      'status', quote_record.status,
      'issue_date', quote_record.issue_date,
      'valid_until', quote_record.valid_until,
      'payment_terms', quote_record.payment_terms,
      'delivery_terms', quote_record.delivery_terms,
      'notes', quote_record.terms,
      'subtotal', quote_record.subtotal,
      'discount_amount', quote_record.discount_amount,
      'freight_amount', quote_record.freight_amount,
      'total', quote_record.total,
      'authorized_discount_percentage', quote_record.authorized_discount_percentage
    ),
    'customer', (
      select jsonb_build_object('legal_name', legal_name, 'nit', nit)
      from public.customers
      where id = quote_record.customer_id
    ),
    'seller', (
      select jsonb_build_object('full_name', full_name, 'phone', phone, 'workplace_address', workplace_address)
      from public.profiles
      where id = quote_record.seller_id
    ),
    'site', case when quote_record.delivery_site_id is null then null else (
      select jsonb_build_object('name', name, 'address', address)
      from public.delivery_sites
      where id = quote_record.delivery_site_id
    ) end,
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', quote_item.id,
          'line_number', quote_item.line_number,
          'product_id', quote_item.product_id,
          'sku', product.sku,
          'description', quote_item.description,
          'quantity', quote_item.quantity,
          'unit_price', quote_item.unit_price,
          'discount_amount', quote_item.discount_amount,
          'line_total', quote_item.line_total
        ) order by quote_item.line_number
      )
      from public.quote_items as quote_item
      inner join public.products as product on product.id = quote_item.product_id
      where quote_item.quote_id = quote_record.id
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', history.id,
          'previous_status', history.previous_status,
          'new_status', history.new_status,
          'reason', history.reason,
          'changed_at', history.changed_at,
          'actor_name', profile.full_name
        ) order by history.changed_at desc
      )
      from public.quote_status_history as history
      left join public.profiles as profile on profile.id = history.changed_by
      where history.quote_id = quote_record.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_quote_detail(uuid) from public;
grant execute on function public.get_quote_detail(uuid) to authenticated;

notify pgrst, 'reload schema';
