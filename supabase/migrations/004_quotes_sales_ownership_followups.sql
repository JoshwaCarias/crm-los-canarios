-- Cotizaciones comerciales, vendedor asignado y seguimiento de clientes.
-- Ejecutar una sola vez después de las migraciones 001 a 003.

alter table public.profiles
  add column if not exists phone text,
  add column if not exists workplace_address text;

create or replace function public.update_my_contact_details(
  p_phone text,
  p_workplace_address text
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'Sesión no válida';
  end if;

  update public.profiles
  set phone = nullif(left(trim(p_phone), 40), ''),
      workplace_address = nullif(left(trim(p_workplace_address), 250), ''),
      updated_at = now()
  where id = auth.uid();
end;
$$;

revoke all on function public.update_my_contact_details(text, text) from public;
grant execute on function public.update_my_contact_details(text, text) to authenticated;

alter table public.customers
  add column if not exists assigned_seller_id uuid references public.profiles(id);

create index if not exists customers_assigned_seller_idx on public.customers (assigned_seller_id);

alter table public.quotes
  add column if not exists payment_terms text not null default 'Efectivo',
  add column if not exists delivery_terms text not null default 'Sujeto a existencias';

create sequence if not exists public.quote_number_seq start with 1000;

do $$
declare
  next_quote_number bigint;
begin
  select coalesce(
    max(nullif(regexp_replace(quote_number, '\D', '', 'g'), '')::bigint),
    999
  ) + 1
  into next_quote_number
  from public.quotes;

  perform setval('public.quote_number_seq', next_quote_number, false);
end;
$$;

alter table public.quotes
  alter column quote_number set default ('COT-' || lpad(nextval('public.quote_number_seq')::text, 6, '0'));

create table if not exists public.customer_follow_ups (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  seller_id uuid not null references public.profiles(id),
  follow_up_type text not null check (follow_up_type in ('call', 'whatsapp', 'email', 'visit', 'other')),
  notes text not null check (char_length(notes) between 1 and 1200),
  next_follow_up_date date,
  created_at timestamptz not null default now()
);

create index if not exists customer_follow_ups_customer_created_idx
  on public.customer_follow_ups (customer_id, created_at desc);

alter table public.customer_follow_ups enable row level security;

create policy "followups: read own or privileged" on public.customer_follow_ups for select to authenticated
  using (
    seller_id = auth.uid()
    or private.has_any_role(array['admin', 'manager']::public.app_role[])
  );
create policy "followups: seller creates own" on public.customer_follow_ups for insert to authenticated
  with check (
    seller_id = auth.uid()
    and private.has_any_role(array['seller', 'admin', 'manager']::public.app_role[])
  );

-- Directorio limitado a datos de contacto de vendedores, sin exponer roles o
-- datos de autenticación. La vista es necesaria para asignar clientes.
create or replace view public.seller_directory as
select
  profile.id,
  profile.full_name,
  profile.phone,
  profile.workplace_address,
  profile.is_active
from public.profiles as profile
inner join public.user_roles as user_role
  on user_role.user_id = profile.id
where user_role.role = 'seller'
  and profile.is_active = true;

grant select on public.seller_directory to authenticated;

-- Un vendedor que crea un cliente queda asignado automáticamente. Sólo un
-- administrador puede reasignar después la cartera a otro vendedor.
create or replace function public.enforce_customer_seller_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, private, auth
as $$
begin
  if tg_op = 'INSERT'
    and new.assigned_seller_id is null
    and private.has_any_role(array['seller']::public.app_role[]) then
    new.assigned_seller_id := auth.uid();
  end if;

  if tg_op = 'UPDATE'
    and new.assigned_seller_id is distinct from old.assigned_seller_id
    and not private.has_any_role(array['admin']::public.app_role[]) then
    raise exception 'Sólo un administrador puede reasignar un cliente';
  end if;

  return new;
end;
$$;

drop trigger if exists customers_enforce_seller_assignment on public.customers;
create trigger customers_enforce_seller_assignment
  before insert or update on public.customers
  for each row execute function public.enforce_customer_seller_assignment();

-- Crea una cotización y sus líneas en una única transacción. El servidor no
-- confía en los totales enviados por el navegador: los recalcula aquí.
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
    p_customer_id, p_delivery_site_id, current_user_id, 'sent', current_date,
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
      total = subtotal_total - discount_total
  where id = quote_id;

  return quote_id;
end;
$$;

revoke all on function public.create_quote(uuid, uuid, text, text, text, jsonb) from public;
grant execute on function public.create_quote(uuid, uuid, text, text, text, jsonb) to authenticated;
