-- Historial comercial, descuento autorizado y ubicación exacta de clientes.
-- Ejecutar una sola vez, después de 001_crm_schema.sql y 002_security.sql.

alter table public.customers
  add column if not exists authorized_discount_percentage numeric(5,2) not null default 5
  check (authorized_discount_percentage >= 0 and authorized_discount_percentage <= 100);

-- La cotización conserva el porcentaje autorizado que tenía el cliente al
-- momento de crearla. El porcentaje aplicado a líneas siempre deberá ser menor
-- o igual a este valor cuando se implemente el módulo de cotizaciones.
alter table public.quotes
  add column if not exists authorized_discount_percentage numeric(5,2)
  check (authorized_discount_percentage >= 0 and authorized_discount_percentage <= 100);

update public.quotes as quote
set authorized_discount_percentage = customer.authorized_discount_percentage
from public.customers as customer
where customer.id = quote.customer_id
  and quote.authorized_discount_percentage is null;

alter table public.quotes
  alter column authorized_discount_percentage set not null;

create or replace function public.set_quote_authorized_discount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select authorized_discount_percentage
  into new.authorized_discount_percentage
  from public.customers
  where id = new.customer_id;

  if new.authorized_discount_percentage is null then
    raise exception 'El cliente de la cotización no tiene descuento autorizado';
  end if;

  return new;
end;
$$;

drop trigger if exists quotes_set_authorized_discount on public.quotes;
create trigger quotes_set_authorized_discount
  before insert or update of customer_id on public.quotes
  for each row execute function public.set_quote_authorized_discount();

alter table public.delivery_sites
  add constraint delivery_sites_latitude_range check (latitude is null or latitude between -90 and 90),
  add constraint delivery_sites_longitude_range check (longitude is null or longitude between -180 and 180);

-- En el CRM la identidad del vendedor y los documentos históricos del cliente
-- son información interna visible para los roles operativos.
drop policy "profiles: read own or privileged" on public.profiles;
create policy "profiles: authenticated read" on public.profiles for select to authenticated using (true);

drop policy "quotes: read according to role" on public.quotes;
create policy "quotes: operational roles read" on public.quotes for select to authenticated
  using (private.has_any_role(array['seller', 'dispatch', 'plant', 'accounting', 'admin', 'manager']::public.app_role[]));

drop policy "orders: read according to role" on public.sales_orders;
create policy "orders: operational roles read" on public.sales_orders for select to authenticated
  using (private.has_any_role(array['seller', 'dispatch', 'plant', 'accounting', 'admin', 'manager']::public.app_role[]));

-- Sólo un administrador modifica un descuento de cliente. La inserción queda
-- disponible para vendedores, administración y gerencia.
drop policy "customers: commercial write" on public.customers;
create policy "customers: commercial create" on public.customers for insert to authenticated
  with check (private.has_any_role(array['seller', 'admin', 'manager']::public.app_role[]));
create policy "customers: admin update" on public.customers for update to authenticated
  using (private.has_any_role(array['admin']::public.app_role[]))
  with check (private.has_any_role(array['admin']::public.app_role[]));
