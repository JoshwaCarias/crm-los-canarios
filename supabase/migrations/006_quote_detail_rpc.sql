-- Lectura segura y consistente de una cotización para su vista imprimible.
-- Ejecutar después de 005_quote_read_policy.sql.

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
      'issue_date', quote_record.issue_date,
      'valid_until', quote_record.valid_until,
      'payment_terms', quote_record.payment_terms,
      'delivery_terms', quote_record.delivery_terms,
      'notes', quote_record.terms,
      'subtotal', quote_record.subtotal,
      'discount_amount', quote_record.discount_amount,
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
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_quote_detail(uuid) from public;
grant execute on function public.get_quote_detail(uuid) to authenticated;

notify pgrst, 'reload schema';
