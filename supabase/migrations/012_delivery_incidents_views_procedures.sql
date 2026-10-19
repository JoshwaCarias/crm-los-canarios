-- Entregable 8: confirmaciones de entrega, incidencias, procedimientos y vistas.
-- Ejecutar después de 011_commercial_targets.sql.
-- Esta migración complementa el módulo de despacho definido en el UML.

create type public.incident_status as enum ('open', 'in_progress', 'closed', 'cancelled');

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null unique references public.shipments(id),
  delivered_at timestamptz not null default now(),
  recipient_name text not null,
  recipient_signature_url text,
  observations text,
  recorded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id),
  incident_type text not null check (incident_type in (
    'delivery_delay', 'vehicle_issue', 'damaged_product', 'route_issue',
    'customer_issue', 'other'
  )),
  description text not null check (char_length(trim(description)) >= 10),
  status public.incident_status not null default 'open',
  occurred_at timestamptz not null default now(),
  reported_by uuid not null references public.profiles(id),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id),
  resolution_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((resolved_at is null and resolved_by is null) or (resolved_at is not null and resolved_by is not null))
);

create index deliveries_shipment_idx on public.deliveries (shipment_id);
create index incidents_shipment_status_idx on public.incidents (shipment_id, status, occurred_at desc);
create index incidents_open_idx on public.incidents (status, occurred_at desc)
  where status in ('open', 'in_progress');

alter table public.deliveries enable row level security;
alter table public.incidents enable row level security;

create policy "deliveries: operational read" on public.deliveries for select to authenticated
  using (
    private.has_any_role(array['dispatch', 'plant', 'accounting', 'admin', 'manager']::public.app_role[])
    or exists (
      select 1
      from public.shipment_items as shipment_item
      inner join public.sales_order_items as order_item on order_item.id = shipment_item.sales_order_item_id
      inner join public.sales_orders as sales_order on sales_order.id = order_item.sales_order_id
      where shipment_item.shipment_id = deliveries.shipment_id
        and sales_order.seller_id = auth.uid()
    )
  );

create policy "incidents: operational read" on public.incidents for select to authenticated
  using (
    private.has_any_role(array['dispatch', 'plant', 'accounting', 'admin', 'manager']::public.app_role[])
    or exists (
      select 1
      from public.shipment_items as shipment_item
      inner join public.sales_order_items as order_item on order_item.id = shipment_item.sales_order_item_id
      inner join public.sales_orders as sales_order on sales_order.id = order_item.sales_order_id
      where shipment_item.shipment_id = incidents.shipment_id
        and sales_order.seller_id = auth.uid()
    )
  );

-- Se conserva el RPC utilizado por la aplicación y se genera la confirmación
-- de entrega de manera atómica cuando el despacho pasa a entregado.
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
  delivery_notes_value text := nullif(trim(coalesce(p_notes, '')), '');
begin
  if current_user_id is null or not private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para actualizar despachos';
  end if;

  select * into shipment_record
  from public.shipments
  where id = p_shipment_id
  for update;

  if shipment_record.id is null then
    raise exception 'El despacho no existe';
  end if;

  if shipment_record.status = 'planned'::public.shipment_status
    and p_next_status = 'loaded'::public.shipment_status then
    update public.shipments
    set status = p_next_status,
        loaded_at = now(),
        delivery_notes = coalesce(delivery_notes_value, delivery_notes)
    where id = p_shipment_id;
  elsif shipment_record.status = 'loaded'::public.shipment_status
    and p_next_status = 'in_transit'::public.shipment_status then
    select sales_order.quote_id into quote_id_value
    from public.shipment_items as shipment_item
    inner join public.sales_order_items as order_item on order_item.id = shipment_item.sales_order_item_id
    inner join public.sales_orders as sales_order on sales_order.id = order_item.sales_order_id
    where shipment_item.shipment_id = p_shipment_id
    limit 1;

    perform public.transition_quote_status(
      quote_id_value,
      'in_route'::public.quote_status,
      coalesce(delivery_notes_value, 'Despacho salió a ruta')
    );

    update public.shipments
    set status = p_next_status,
        delivery_notes = coalesce(delivery_notes_value, delivery_notes)
    where id = p_shipment_id;
  elsif shipment_record.status = 'in_transit'::public.shipment_status
    and p_next_status = 'delivered'::public.shipment_status then
    select sales_order.quote_id into quote_id_value
    from public.shipment_items as shipment_item
    inner join public.sales_order_items as order_item on order_item.id = shipment_item.sales_order_item_id
    inner join public.sales_orders as sales_order on sales_order.id = order_item.sales_order_id
    where shipment_item.shipment_id = p_shipment_id
    limit 1;

    perform public.transition_quote_status(
      quote_id_value,
      'delivered'::public.quote_status,
      coalesce(delivery_notes_value, 'Entrega confirmada desde despacho')
    );

    update public.shipments
    set status = p_next_status,
        delivered_at = now(),
        delivery_notes = coalesce(delivery_notes_value, delivery_notes)
    where id = p_shipment_id;

    insert into public.deliveries (
      shipment_id, delivered_at, recipient_name, recipient_signature_url,
      observations, recorded_by
    ) values (
      p_shipment_id,
      now(),
      coalesce(nullif(trim(shipment_record.recipient_name), ''), 'Pendiente de confirmar'),
      shipment_record.recipient_signature_url,
      coalesce(delivery_notes_value, shipment_record.delivery_notes),
      current_user_id
    ) on conflict (shipment_id) do update
      set delivered_at = excluded.delivered_at,
          recipient_name = excluded.recipient_name,
          recipient_signature_url = excluded.recipient_signature_url,
          observations = excluded.observations,
          recorded_by = excluded.recorded_by;

    insert into public.audit_log (actor_id, entity_type, entity_id, action, after_data, reason)
    values (
      current_user_id,
      'shipment',
      p_shipment_id,
      'delivery_confirmed',
      jsonb_build_object('status', 'delivered', 'delivered_at', now()),
      delivery_notes_value
    );
  else
    raise exception 'La transición de despacho no corresponde al estado actual';
  end if;
end;
$$;

-- Procedimiento almacenado para registrar una incidencia de despacho.
-- Se invoca con CALL desde una consola administrativa o integración segura.
create or replace procedure public.sp_register_incident(
  in p_shipment_id uuid,
  in p_incident_type text,
  in p_description text,
  in p_occurred_at timestamptz default now()
)
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
  incident_id uuid;
begin
  if current_user_id is null or not private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para registrar incidencias';
  end if;

  if not exists (select 1 from public.shipments where id = p_shipment_id) then
    raise exception 'El despacho no existe';
  end if;

  if p_incident_type not in ('delivery_delay', 'vehicle_issue', 'damaged_product', 'route_issue', 'customer_issue', 'other') then
    raise exception 'El tipo de incidencia no es válido';
  end if;

  if char_length(trim(coalesce(p_description, ''))) < 10 then
    raise exception 'Describe la incidencia con al menos 10 caracteres';
  end if;

  insert into public.incidents (
    shipment_id, incident_type, description, occurred_at, reported_by
  ) values (
    p_shipment_id,
    p_incident_type,
    trim(p_description),
    coalesce(p_occurred_at, now()),
    current_user_id
  ) returning id into incident_id;

  insert into public.audit_log (actor_id, entity_type, entity_id, action, after_data)
  values (
    current_user_id,
    'incident',
    incident_id,
    'created',
    jsonb_build_object('shipment_id', p_shipment_id, 'incident_type', p_incident_type)
  );
end;
$$;

-- Procedimiento almacenado para confirmar una entrega y conservar su evidencia.
create or replace procedure public.sp_register_delivery(
  in p_shipment_id uuid,
  in p_recipient_name text,
  in p_recipient_signature_url text default null,
  in p_observations text default null
)
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null or not private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para registrar entregas';
  end if;

  if nullif(trim(coalesce(p_recipient_name, '')), '') is null then
    raise exception 'Indica el nombre de quien recibe';
  end if;

  perform public.advance_shipment_status(
    p_shipment_id,
    'delivered'::public.shipment_status,
    p_observations
  );

  update public.deliveries
  set recipient_name = trim(p_recipient_name),
      recipient_signature_url = nullif(trim(coalesce(p_recipient_signature_url, '')), ''),
      observations = coalesce(nullif(trim(coalesce(p_observations, '')), ''), observations)
  where shipment_id = p_shipment_id;

  update public.shipments
  set recipient_name = trim(p_recipient_name),
      recipient_signature_url = nullif(trim(coalesce(p_recipient_signature_url, '')), '')
  where id = p_shipment_id;
end;
$$;

-- Vistas para operación y reportes. security_invoker mantiene las reglas RLS
-- de las tablas que las componen para el usuario que consulta.
create or replace view public.vw_operational_dispatches
with (security_invoker = true)
as
select
  shipment.id as shipment_id,
  shipment.shipment_number,
  shipment.status as shipment_status,
  shipment.scheduled_at,
  shipment.loaded_at,
  shipment.delivered_at,
  sales_order.order_number,
  customer.legal_name as customer_name,
  delivery_site.name as delivery_site_name,
  delivery_site.address as delivery_address,
  vehicle.plate as vehicle_plate,
  driver.full_name as driver_name,
  shipment.freight_charge,
  shipment.freight_cost
from public.shipments as shipment
left join lateral (
  select distinct sales_order_inner.*
  from public.shipment_items as shipment_item
  inner join public.sales_order_items as order_item on order_item.id = shipment_item.sales_order_item_id
  inner join public.sales_orders as sales_order_inner on sales_order_inner.id = order_item.sales_order_id
  where shipment_item.shipment_id = shipment.id
  limit 1
) as sales_order on true
left join public.customers as customer on customer.id = sales_order.customer_id
left join public.delivery_sites as delivery_site on delivery_site.id = shipment.delivery_site_id
left join public.vehicles as vehicle on vehicle.id = shipment.vehicle_id
left join public.drivers as driver on driver.id = shipment.driver_id;

create or replace view public.vw_pending_orders
with (security_invoker = true)
as
select
  sales_order.id as sales_order_id,
  sales_order.order_number,
  sales_order.status,
  sales_order.requested_delivery_date,
  sales_order.total,
  sales_order.freight_amount,
  sales_order.payment_terms,
  customer.legal_name as customer_name,
  profile.full_name as seller_name,
  delivery_site.name as delivery_site_name,
  delivery_site.address as delivery_address
from public.sales_orders as sales_order
inner join public.customers as customer on customer.id = sales_order.customer_id
inner join public.profiles as profile on profile.id = sales_order.seller_id
left join public.delivery_sites as delivery_site on delivery_site.id = sales_order.delivery_site_id
where sales_order.status not in ('delivered', 'invoiced', 'closed', 'cancelled');

create or replace view public.vw_delivery_incidents
with (security_invoker = true)
as
select
  incident.id as incident_id,
  incident.incident_type,
  incident.description,
  incident.status as incident_status,
  incident.occurred_at,
  incident.resolved_at,
  incident.resolution_notes,
  shipment.id as shipment_id,
  shipment.shipment_number,
  shipment.status as shipment_status,
  customer.legal_name as customer_name,
  delivery_site.name as delivery_site_name,
  reporter.full_name as reported_by_name,
  resolver.full_name as resolved_by_name
from public.incidents as incident
inner join public.shipments as shipment on shipment.id = incident.shipment_id
left join lateral (
  select distinct sales_order_inner.*
  from public.shipment_items as shipment_item
  inner join public.sales_order_items as order_item on order_item.id = shipment_item.sales_order_item_id
  inner join public.sales_orders as sales_order_inner on sales_order_inner.id = order_item.sales_order_id
  where shipment_item.shipment_id = shipment.id
  limit 1
) as sales_order on true
left join public.customers as customer on customer.id = sales_order.customer_id
left join public.delivery_sites as delivery_site on delivery_site.id = shipment.delivery_site_id
left join public.profiles as reporter on reporter.id = incident.reported_by
left join public.profiles as resolver on resolver.id = incident.resolved_by;

grant select on public.vw_operational_dispatches to authenticated;
grant select on public.vw_pending_orders to authenticated;
grant select on public.vw_delivery_incidents to authenticated;

revoke all on procedure public.sp_register_incident(uuid, text, text, timestamptz) from public;
grant execute on procedure public.sp_register_incident(uuid, text, text, timestamptz) to authenticated;
revoke all on procedure public.sp_register_delivery(uuid, text, text, text) from public;
grant execute on procedure public.sp_register_delivery(uuid, text, text, text) to authenticated;

revoke all on function public.advance_shipment_status(uuid, public.shipment_status, text) from public;
grant execute on function public.advance_shipment_status(uuid, public.shipment_status, text) to authenticated;

notify pgrst, 'reload schema';
