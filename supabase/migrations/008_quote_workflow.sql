-- Parte 2 del flujo de cotizaciones. Ejecutar sólo después de que 007 haya
-- terminado correctamente en una ejecución anterior del SQL Editor.

-- Las cotizaciones que se emitieron antes de este flujo pasan a revisión
-- administrativa, nunca se aprueban automáticamente.
update public.quotes
set status = 'pending_admin_approval'::public.quote_status
where status = 'sent'::public.quote_status;

create table if not exists public.quote_status_history (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  previous_status public.quote_status,
  new_status public.quote_status not null,
  changed_by uuid not null references public.profiles(id),
  reason text,
  changed_at timestamptz not null default now()
);

create index if not exists quote_status_history_quote_changed_idx
  on public.quote_status_history (quote_id, changed_at desc);

-- Deja trazabilidad también para los documentos emitidos antes de instalar el
-- flujo. La condición evita duplicarlo si la migración se vuelve a ejecutar.
insert into public.quote_status_history (quote_id, previous_status, new_status, changed_by, reason)
select
  quote.id,
  'sent'::public.quote_status,
  'pending_admin_approval'::public.quote_status,
  quote.seller_id,
  'Cotización existente incorporada al flujo de aprobación'
from public.quotes as quote
where quote.status = 'pending_admin_approval'::public.quote_status
  and not exists (
    select 1
    from public.quote_status_history as history
    where history.quote_id = quote.id
  );

alter table public.quote_status_history enable row level security;

drop policy if exists "quote history: related quote read" on public.quote_status_history;
create policy "quote history: related quote read" on public.quote_status_history for select to authenticated
  using (
    exists (
      select 1
      from public.quotes as quote
      where quote.id = quote_id
        and (
          quote.seller_id = auth.uid()
          or private.has_any_role(array['dispatch', 'plant', 'accounting', 'admin', 'manager']::public.app_role[])
        )
    )
  );

-- Todas las mutaciones pasan por las funciones de abajo. Esto evita que el
-- navegador pueda editar importes o cambiar de estado directamente por REST.
drop policy if exists "quotes: seller create own" on public.quotes;
drop policy if exists "quotes: seller update own" on public.quotes;
drop policy if exists "quote_items: seller write related quote" on public.quote_items;

create or replace function public.create_quote(
  p_customer_id uuid,
  p_delivery_site_id uuid,
  p_payment_terms text,
  p_delivery_terms text,
  p_notes text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
  quote_id uuid;
  customer_discount numeric(5,2);
  assigned_seller uuid;
  quote_line jsonb;
  product_record record;
  line_number integer := 0;
  requested_quantity numeric(14,3);
  requested_price numeric(14,2);
  requested_discount numeric(5,2);
  line_subtotal numeric(14,2);
  line_discount numeric(14,2);
  line_total numeric(14,2);
  subtotal_total numeric(14,2) := 0;
  discount_total numeric(14,2) := 0;
begin
  if current_user_id is null
    or not private.has_any_role(array['seller', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para crear cotizaciones';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Agrega al menos un producto a la cotización';
  end if;

  select authorized_discount_percentage, assigned_seller_id
  into customer_discount, assigned_seller
  from public.customers
  where id = p_customer_id
    and is_active = true;

  if customer_discount is null then
    raise exception 'El cliente no existe o está inactivo';
  end if;

  if private.has_any_role(array['seller']::public.app_role[])
    and not private.has_any_role(array['admin', 'manager']::public.app_role[])
    and assigned_seller is not null
    and assigned_seller <> current_user_id then
    raise exception 'Este cliente está asignado a otro vendedor';
  end if;

  if p_delivery_site_id is not null
    and not exists (
      select 1 from public.delivery_sites
      where id = p_delivery_site_id
        and customer_id = p_customer_id
        and is_active = true
    ) then
    raise exception 'La dirección de entrega no pertenece al cliente';
  end if;

  insert into public.quotes (
    customer_id, delivery_site_id, seller_id, status, issue_date,
    valid_until, currency, subtotal, discount_amount, tax_amount, total,
    payment_terms, delivery_terms, terms
  ) values (
    p_customer_id, p_delivery_site_id, current_user_id, 'pending_admin_approval', current_date,
    current_date + 10, 'GTQ', 0, 0, 0, 0,
    coalesce(nullif(trim(p_payment_terms), ''), 'Efectivo'),
    coalesce(nullif(trim(p_delivery_terms), ''), 'Sujeto a existencias'),
    nullif(trim(p_notes), '')
  ) returning id into quote_id;

  for quote_line in select value from jsonb_array_elements(p_items)
  loop
    line_number := line_number + 1;
    requested_quantity := (quote_line ->> 'quantity')::numeric;
    requested_price := (quote_line ->> 'unitPrice')::numeric;
    requested_discount := coalesce((quote_line ->> 'discountPercentage')::numeric, 0);

    if requested_quantity <= 0 or requested_price < 0 then
      raise exception 'Cada línea requiere cantidad positiva y precio válido';
    end if;
    if requested_discount < 0 or requested_discount > customer_discount then
      raise exception 'El descuento de una línea supera el porcentaje autorizado del cliente (%)', customer_discount;
    end if;

    select sku, name, description
    into product_record
    from public.products
    where id = (quote_line ->> 'productId')::uuid
      and is_active = true;

    if product_record.sku is null then
      raise exception 'Uno de los productos no existe o está inactivo';
    end if;

    line_subtotal := round(requested_quantity * requested_price, 2);
    line_discount := round(line_subtotal * requested_discount / 100, 2);
    line_total := line_subtotal - line_discount;
    subtotal_total := subtotal_total + line_subtotal;
    discount_total := discount_total + line_discount;

    insert into public.quote_items (
      quote_id, line_number, product_id, description, quantity, unit_price,
      discount_amount, tax_amount, line_total
    ) values (
      quote_id, line_number, (quote_line ->> 'productId')::uuid,
      coalesce(product_record.description, product_record.name), requested_quantity,
      requested_price, line_discount, 0, line_total
    );
  end loop;

  update public.quotes
  set subtotal = subtotal_total,
      discount_amount = discount_total,
      tax_amount = 0,
      total = subtotal_total - discount_total,
      updated_at = now()
  where id = quote_id;

  insert into public.quote_status_history (quote_id, previous_status, new_status, changed_by, reason)
  values (quote_id, null, 'pending_admin_approval', current_user_id, 'Cotización creada por el vendedor');

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
  p_items jsonb
)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
  quote_record public.quotes%rowtype;
  customer_discount numeric(5,2);
  assigned_seller uuid;
  quote_line jsonb;
  product_record record;
  line_number integer := 0;
  requested_quantity numeric(14,3);
  requested_price numeric(14,2);
  requested_discount numeric(5,2);
  line_subtotal numeric(14,2);
  line_discount numeric(14,2);
  line_total numeric(14,2);
  subtotal_total numeric(14,2) := 0;
  discount_total numeric(14,2) := 0;
  may_manage boolean := private.has_any_role(array['admin', 'manager']::public.app_role[]);
begin
  if current_user_id is null then
    raise exception 'Sesión no válida';
  end if;

  select * into quote_record
  from public.quotes
  where id = p_quote_id;

  if quote_record.id is null then
    raise exception 'La cotización no existe';
  end if;

  if quote_record.status not in (
    'pending_admin_approval'::public.quote_status,
    'approved'::public.quote_status,
    'in_production'::public.quote_status
  ) then
    raise exception 'La cotización ya llegó a despacho o fue cerrada y no puede modificarse';
  end if;

  if not may_manage and (
    quote_record.seller_id <> current_user_id
    or not private.has_any_role(array['seller']::public.app_role[])
  ) then
    raise exception 'Sólo el vendedor responsable o Administración puede modificar esta cotización';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Agrega al menos un producto a la cotización';
  end if;

  select authorized_discount_percentage, assigned_seller_id
  into customer_discount, assigned_seller
  from public.customers
  where id = p_customer_id
    and is_active = true;

  if customer_discount is null then
    raise exception 'El cliente no existe o está inactivo';
  end if;

  if not may_manage
    and private.has_any_role(array['seller']::public.app_role[])
    and assigned_seller is not null
    and assigned_seller <> quote_record.seller_id then
    raise exception 'Este cliente está asignado a otro vendedor';
  end if;

  if p_delivery_site_id is not null
    and not exists (
      select 1 from public.delivery_sites
      where id = p_delivery_site_id
        and customer_id = p_customer_id
        and is_active = true
    ) then
    raise exception 'La dirección de entrega no pertenece al cliente';
  end if;

  delete from public.quote_items where quote_id = p_quote_id;

  for quote_line in select value from jsonb_array_elements(p_items)
  loop
    line_number := line_number + 1;
    requested_quantity := (quote_line ->> 'quantity')::numeric;
    requested_price := (quote_line ->> 'unitPrice')::numeric;
    requested_discount := coalesce((quote_line ->> 'discountPercentage')::numeric, 0);

    if requested_quantity <= 0 or requested_price < 0 then
      raise exception 'Cada línea requiere cantidad positiva y precio válido';
    end if;
    if requested_discount < 0 or requested_discount > customer_discount then
      raise exception 'El descuento de una línea supera el porcentaje autorizado del cliente (%)', customer_discount;
    end if;

    select sku, name, description
    into product_record
    from public.products
    where id = (quote_line ->> 'productId')::uuid
      and is_active = true;

    if product_record.sku is null then
      raise exception 'Uno de los productos no existe o está inactivo';
    end if;

    line_subtotal := round(requested_quantity * requested_price, 2);
    line_discount := round(line_subtotal * requested_discount / 100, 2);
    line_total := line_subtotal - line_discount;
    subtotal_total := subtotal_total + line_subtotal;
    discount_total := discount_total + line_discount;

    insert into public.quote_items (
      quote_id, line_number, product_id, description, quantity, unit_price,
      discount_amount, tax_amount, line_total
    ) values (
      p_quote_id, line_number, (quote_line ->> 'productId')::uuid,
      coalesce(product_record.description, product_record.name), requested_quantity,
      requested_price, line_discount, 0, line_total
    );
  end loop;

  update public.quotes
  set customer_id = p_customer_id,
      delivery_site_id = p_delivery_site_id,
      payment_terms = coalesce(nullif(trim(p_payment_terms), ''), 'Efectivo'),
      delivery_terms = coalesce(nullif(trim(p_delivery_terms), ''), 'Sujeto a existencias'),
      terms = nullif(trim(p_notes), ''),
      subtotal = subtotal_total,
      discount_amount = discount_total,
      tax_amount = 0,
      total = subtotal_total - discount_total,
      status = 'pending_admin_approval',
      updated_at = now()
  where id = p_quote_id;

  insert into public.quote_status_history (quote_id, previous_status, new_status, changed_by, reason)
  values (
    p_quote_id,
    quote_record.status,
    'pending_admin_approval',
    current_user_id,
    'Cotización modificada; requiere nueva aprobación administrativa'
  );
end;
$$;

create or replace function public.transition_quote_status(
  p_quote_id uuid,
  p_next_status public.quote_status,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
  quote_record public.quotes%rowtype;
  can_administrate boolean := private.has_any_role(array['admin', 'manager']::public.app_role[]);
  can_plant boolean := private.has_any_role(array['plant', 'admin', 'manager']::public.app_role[]);
  can_dispatch boolean := private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]);
  is_own_seller boolean;
  transition_allowed boolean := false;
begin
  if current_user_id is null then
    raise exception 'Sesión no válida';
  end if;

  select * into quote_record
  from public.quotes
  where id = p_quote_id;

  if quote_record.id is null then
    raise exception 'La cotización no existe';
  end if;

  if quote_record.status in ('cancelled'::public.quote_status, 'delivered'::public.quote_status) then
    raise exception 'La cotización ya está cerrada y no puede cambiar de estado';
  end if;

  is_own_seller := quote_record.seller_id = current_user_id
    and private.has_any_role(array['seller']::public.app_role[]);

  if p_next_status = 'cancelled'::public.quote_status then
    if nullif(trim(coalesce(p_reason, '')), '') is null then
      raise exception 'Indica el motivo de la cancelación';
    end if;

    transition_allowed := can_administrate
      or (is_own_seller and quote_record.status = 'pending_admin_approval'::public.quote_status)
      or (can_dispatch and quote_record.status in (
        'pending_dispatch_authorization'::public.quote_status,
        'in_dispatch'::public.quote_status
      ));
  elsif quote_record.status = 'pending_admin_approval'::public.quote_status
    and p_next_status = 'approved'::public.quote_status then
    transition_allowed := can_administrate;
  elsif quote_record.status = 'approved'::public.quote_status
    and p_next_status = 'in_production'::public.quote_status then
    transition_allowed := can_plant;
  elsif quote_record.status = 'in_production'::public.quote_status
    and p_next_status = 'pending_dispatch_authorization'::public.quote_status then
    transition_allowed := can_plant;
  elsif quote_record.status = 'pending_dispatch_authorization'::public.quote_status
    and p_next_status = 'in_dispatch'::public.quote_status then
    transition_allowed := can_dispatch;
  elsif quote_record.status = 'in_dispatch'::public.quote_status
    and p_next_status = 'in_route'::public.quote_status then
    transition_allowed := can_dispatch;
  elsif quote_record.status = 'in_route'::public.quote_status
    and p_next_status = 'delivered'::public.quote_status then
    transition_allowed := can_dispatch;
  end if;

  if not transition_allowed then
    raise exception 'No tienes permiso para realizar esta transición o no corresponde al estado actual';
  end if;

  update public.quotes
  set status = p_next_status,
      updated_at = now()
  where id = p_quote_id;

  insert into public.quote_status_history (quote_id, previous_status, new_status, changed_by, reason)
  values (
    p_quote_id,
    quote_record.status,
    p_next_status,
    current_user_id,
    nullif(left(trim(coalesce(p_reason, '')), 1200), '')
  );
end;
$$;

revoke all on function public.create_quote(uuid, uuid, text, text, text, jsonb) from public;
grant execute on function public.create_quote(uuid, uuid, text, text, text, jsonb) to authenticated;
revoke all on function public.update_quote(uuid, uuid, uuid, text, text, text, jsonb) from public;
grant execute on function public.update_quote(uuid, uuid, uuid, text, text, text, jsonb) to authenticated;
revoke all on function public.transition_quote_status(uuid, public.quote_status, text) from public;
grant execute on function public.transition_quote_status(uuid, public.quote_status, text) to authenticated;

-- La vista imprimible recibe una única respuesta autorizada y además expone el
-- estado y la bitácora para la pantalla operativa.
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
