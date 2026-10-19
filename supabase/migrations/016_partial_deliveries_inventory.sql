-- Entregas parciales, disponibilidad de inventario y facturación por día.
-- Ejecutar después de 015_shipment_reschedule_rpc.sql.
-- Una entrega parcial agrupa todos los fletes del mismo pedido realizados el
-- mismo día. Sólo se factura cuando todos esos fletes están entregados.

create sequence if not exists public.delivery_group_number_seq start with 1000;

create table if not exists public.delivery_groups (
  id uuid primary key default gen_random_uuid(),
  delivery_number text not null unique default ('ENT-' || lpad(nextval('public.delivery_group_number_seq')::text, 6, '0')),
  sales_order_id uuid not null references public.sales_orders(id),
  delivery_date date not null,
  status text not null default 'planned' check (status in ('planned', 'in_progress', 'delivered', 'invoiced', 'cancelled')),
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sales_order_id, delivery_date)
);

alter table public.shipments
  add column if not exists delivery_group_id uuid references public.delivery_groups(id);

alter table public.invoices
  add column if not exists delivery_group_id uuid references public.delivery_groups(id);

alter table public.sales_orders
  add column if not exists priority_level integer not null default 3 check (priority_level between 1 and 4),
  add column if not exists actual_freight_amount numeric(14,2) not null default 0 check (actual_freight_amount >= 0);

create table if not exists public.inventory_allocations (
  id uuid primary key default gen_random_uuid(),
  sales_order_item_id uuid not null references public.sales_order_items(id) on delete cascade,
  location_id uuid not null references public.inventory_locations(id),
  quantity numeric(14,3) not null,
  status text not null default 'reserved' check (status in ('reserved', 'consumed', 'released')),
  released_reason text,
  released_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.inventory_allocations
  drop constraint if exists inventory_allocations_quantity_check;
alter table public.inventory_allocations
  add constraint inventory_allocations_quantity_check check (
    (status = 'reserved' and quantity > 0)
    or (status in ('consumed', 'released') and quantity >= 0)
  );

create index if not exists delivery_groups_order_date_idx on public.delivery_groups (sales_order_id, delivery_date);
create index if not exists shipments_delivery_group_idx on public.shipments (delivery_group_id);
create unique index if not exists invoices_delivery_group_once_idx
  on public.invoices (delivery_group_id)
  where delivery_group_id is not null;
create index if not exists inventory_allocations_order_item_status_idx
  on public.inventory_allocations (sales_order_item_id, status);
create index if not exists inventory_allocations_location_status_idx
  on public.inventory_allocations (location_id, status);

-- El MVP anterior impedía varias facturas para un mismo pedido marco.
drop index if exists public.invoices_sales_order_once_idx;

-- Conserva los despachos existentes dentro de una entrega histórica por día.
insert into public.delivery_groups (sales_order_id, delivery_date, status, notes)
select distinct on (order_item.sales_order_id, (shipment.scheduled_at at time zone 'America/Guatemala')::date)
  order_item.sales_order_id,
  (shipment.scheduled_at at time zone 'America/Guatemala')::date,
  case when shipment.status = 'delivered'::public.shipment_status then 'delivered' else 'in_progress' end,
  'Entrega creada al habilitar entregas parciales'
from public.shipments as shipment
inner join public.shipment_items as shipment_item on shipment_item.shipment_id = shipment.id
inner join public.sales_order_items as order_item on order_item.id = shipment_item.sales_order_item_id
where shipment.delivery_group_id is null
on conflict (sales_order_id, delivery_date) do nothing;

update public.shipments as shipment
set delivery_group_id = delivery_group.id
from public.shipment_items as shipment_item
inner join public.sales_order_items as order_item on order_item.id = shipment_item.sales_order_item_id
inner join public.delivery_groups as delivery_group
  on delivery_group.sales_order_id = order_item.sales_order_id
where shipment_item.shipment_id = shipment.id
  and delivery_group.delivery_date = (shipment.scheduled_at at time zone 'America/Guatemala')::date
  and shipment.delivery_group_id is null;

-- Las salidas de inventario reservadas no alteran la existencia física.
create or replace function private.stock_available_at_location(
  p_product_id uuid,
  p_location_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = public, private
as $$
  with physical_stock as (
    select coalesce(sum(quantity) filter (
      where movement_type not in ('reservation'::public.inventory_movement_type, 'reservation_release'::public.inventory_movement_type)
    ), 0) as quantity
    from public.inventory_movements
    where product_id = p_product_id and location_id = p_location_id
  ), reserved_stock as (
    select coalesce(sum(allocation.quantity), 0) as quantity
    from public.inventory_allocations as allocation
    inner join public.sales_order_items as order_item on order_item.id = allocation.sales_order_item_id
    where allocation.location_id = p_location_id
      and order_item.product_id = p_product_id
      and allocation.status = 'reserved'
  )
  select greatest(0, physical_stock.quantity - reserved_stock.quantity)
  from physical_stock cross join reserved_stock;
$$;

create or replace function public.get_product_availability(p_product_ids uuid[] default null)
returns table (
  product_id uuid,
  on_hand_quantity numeric,
  reserved_quantity numeric,
  available_quantity numeric
)
language plpgsql
stable
security definer
set search_path = public, private, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'Sesión no válida';
  end if;

  return query
  with physical_stock as (
    select movement.product_id, coalesce(sum(movement.quantity) filter (
      where movement.movement_type not in ('reservation'::public.inventory_movement_type, 'reservation_release'::public.inventory_movement_type)
    ), 0) as quantity
    from public.inventory_movements as movement
    group by movement.product_id
  ), reserved_stock as (
    select order_item.product_id, coalesce(sum(allocation.quantity), 0) as quantity
    from public.inventory_allocations as allocation
    inner join public.sales_order_items as order_item on order_item.id = allocation.sales_order_item_id
    where allocation.status = 'reserved'
    group by order_item.product_id
  )
  select
    product.id,
    coalesce(physical_stock.quantity, 0),
    coalesce(reserved_stock.quantity, 0),
    greatest(0, coalesce(physical_stock.quantity, 0) - coalesce(reserved_stock.quantity, 0))
  from public.products as product
  left join physical_stock on physical_stock.product_id = product.id
  left join reserved_stock on reserved_stock.product_id = product.id
  where p_product_ids is null or product.id = any(p_product_ids)
  order by product.name;
end;
$$;

-- Reserva automáticamente sólo el inventario libre. Lo que no se reserve se
-- convierte en necesidad de fabricación del pedido.
create or replace function private.auto_allocate_order_item(p_sales_order_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  item_record public.sales_order_items%rowtype;
  order_status public.sales_order_status;
  active_reserved numeric(14,3);
  quantity_to_allocate numeric(14,3);
  location_record record;
  free_quantity numeric(14,3);
  allocation_quantity numeric(14,3);
begin
  select order_item.*
  into item_record
  from public.sales_order_items as order_item
  where order_item.id = p_sales_order_item_id
  for update of order_item;

  select status into order_status
  from public.sales_orders
  where id = item_record.sales_order_id;

  if item_record.id is null or order_status not in (
    'pending_fulfillment'::public.sales_order_status,
    'ready_for_dispatch'::public.sales_order_status,
    'partially_delivered'::public.sales_order_status
  ) then
    return;
  end if;

  select coalesce(sum(quantity), 0) into active_reserved
  from public.inventory_allocations
  where sales_order_item_id = item_record.id and status = 'reserved';

  quantity_to_allocate := greatest(0, item_record.ordered_quantity - item_record.delivered_quantity - active_reserved);
  if quantity_to_allocate <= 0 then
    return;
  end if;

  for location_record in
    select id from public.inventory_locations where is_active = true order by code
  loop
    free_quantity := private.stock_available_at_location(item_record.product_id, location_record.id);
    allocation_quantity := least(quantity_to_allocate, free_quantity);
    if allocation_quantity > 0 then
      insert into public.inventory_allocations (sales_order_item_id, location_id, quantity, created_by)
      values (item_record.id, location_record.id, allocation_quantity, auth.uid());
      update public.sales_order_items
      set reserved_quantity = reserved_quantity + allocation_quantity
      where id = item_record.id;
      quantity_to_allocate := quantity_to_allocate - allocation_quantity;
    end if;
    exit when quantity_to_allocate <= 0;
  end loop;
end;
$$;

create or replace function private.auto_allocate_product(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  item_record record;
begin
  for item_record in
    select order_item.id
    from public.sales_order_items as order_item
    inner join public.sales_orders as sales_order on sales_order.id = order_item.sales_order_id
    where order_item.product_id = p_product_id
      and sales_order.status in (
        'pending_fulfillment'::public.sales_order_status,
        'ready_for_dispatch'::public.sales_order_status,
        'partially_delivered'::public.sales_order_status
      )
      and order_item.delivered_quantity < order_item.ordered_quantity
    order by sales_order.priority_level asc, sales_order.created_at asc, order_item.line_number asc
  loop
    perform private.auto_allocate_order_item(item_record.id);
  end loop;
end;
$$;

create or replace function public.allocate_inventory_after_order_item_insert()
returns trigger
language plpgsql
security definer
set search_path = public, private, auth
as $$
begin
  perform private.auto_allocate_order_item(new.id);
  return new;
end;
$$;

drop trigger if exists sales_order_items_auto_allocate_inventory on public.sales_order_items;
create trigger sales_order_items_auto_allocate_inventory
  after insert on public.sales_order_items
  for each row execute function public.allocate_inventory_after_order_item_insert();

-- Inicializa cantidades históricas entregadas y reserva existencias para los
-- pedidos abiertos que fueron creados antes de esta extensión.
update public.sales_order_items as order_item
set delivered_quantity = least(order_item.ordered_quantity, delivered.total_quantity)
from (
  select shipment_item.sales_order_item_id, coalesce(sum(shipment_item.loaded_quantity), 0) as total_quantity
  from public.shipment_items as shipment_item
  inner join public.shipments as shipment on shipment.id = shipment_item.shipment_id
  where shipment.status = 'delivered'::public.shipment_status
  group by shipment_item.sales_order_item_id
) as delivered
where delivered.sales_order_item_id = order_item.id
  and order_item.delivered_quantity = 0;

do $$
declare
  item_record record;
begin
  for item_record in
    select order_item.id
    from public.sales_order_items as order_item
    inner join public.sales_orders as sales_order on sales_order.id = order_item.sales_order_id
    where sales_order.status in (
      'pending_fulfillment'::public.sales_order_status,
      'ready_for_dispatch'::public.sales_order_status,
      'partially_delivered'::public.sales_order_status
    )
  loop
    perform private.auto_allocate_order_item(item_record.id);
  end loop;
end;
$$;

create or replace function public.set_sales_order_priority(
  p_sales_order_id uuid,
  p_priority_level integer
)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
begin
  if auth.uid() is null or not private.has_any_role(array['dispatch', 'plant', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para cambiar la prioridad';
  end if;
  if p_priority_level not between 1 and 4 then
    raise exception 'La prioridad debe estar entre 1 (urgente) y 4 (baja)';
  end if;
  update public.sales_orders
  set priority_level = p_priority_level, updated_at = now()
  where id = p_sales_order_id
    and status not in ('delivered'::public.sales_order_status, 'invoiced'::public.sales_order_status, 'closed'::public.sales_order_status, 'cancelled'::public.sales_order_status);
  if not found then
    raise exception 'El pedido no está disponible para cambiar prioridad';
  end if;
end;
$$;

-- Reasigna una reserva libre de un pedido a otro del mismo producto. No mueve
-- existencia física: deja una traza operativa y cambia la reserva logística.
create or replace function public.reallocate_inventory_reservation(
  p_from_order_item_id uuid,
  p_to_order_item_id uuid,
  p_quantity numeric,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  source_item public.sales_order_items%rowtype;
  target_item public.sales_order_items%rowtype;
  reserved_quantity numeric(14,3);
  committed_quantity numeric(14,3);
  target_need numeric(14,3);
  remaining_quantity numeric(14,3);
  allocation_record record;
  moved_quantity numeric(14,3);
begin
  if auth.uid() is null or not private.has_any_role(array['dispatch', 'plant', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para reasignar reservas';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_from_order_item_id = p_to_order_item_id then
    raise exception 'Indica dos líneas distintas y una cantidad válida';
  end if;

  select * into source_item from public.sales_order_items where id = p_from_order_item_id for update;
  select * into target_item from public.sales_order_items where id = p_to_order_item_id for update;
  if source_item.id is null or target_item.id is null or source_item.product_id <> target_item.product_id then
    raise exception 'Las líneas deben existir y corresponder al mismo producto';
  end if;

  select coalesce(sum(quantity), 0) into reserved_quantity
  from public.inventory_allocations
  where sales_order_item_id = source_item.id and status = 'reserved';
  select coalesce(sum(shipment_item.loaded_quantity), 0) into committed_quantity
  from public.shipment_items as shipment_item
  inner join public.shipments as shipment on shipment.id = shipment_item.shipment_id
  where shipment_item.sales_order_item_id = source_item.id
    and shipment.status in ('planned'::public.shipment_status, 'loaded'::public.shipment_status, 'in_transit'::public.shipment_status);
  select greatest(0, target_item.ordered_quantity - target_item.delivered_quantity - coalesce(sum(quantity), 0))
  into target_need
  from public.inventory_allocations
  where sales_order_item_id = target_item.id and status = 'reserved';

  if p_quantity > reserved_quantity - committed_quantity then
    raise exception 'La línea origen no tiene esa cantidad libre para reasignar';
  end if;
  if p_quantity > target_need then
    raise exception 'La línea destino no necesita esa cantidad';
  end if;

  remaining_quantity := p_quantity;
  for allocation_record in
    select * from public.inventory_allocations
    where sales_order_item_id = source_item.id and status = 'reserved'
    order by created_at, id
    for update
  loop
    moved_quantity := least(remaining_quantity, allocation_record.quantity);
    if moved_quantity > 0 then
      update public.inventory_allocations
      set quantity = quantity - moved_quantity,
          status = case when quantity - moved_quantity = 0 then 'released' else status end,
          released_at = case when quantity - moved_quantity = 0 then now() else released_at end,
          released_reason = case when quantity - moved_quantity = 0 then coalesce(nullif(trim(p_reason), ''), 'Reasignada a pedido prioritario') else released_reason end,
          updated_at = now()
      where id = allocation_record.id;
      insert into public.inventory_allocations (sales_order_item_id, location_id, quantity, created_by)
      values (target_item.id, allocation_record.location_id, moved_quantity, auth.uid());
      update public.sales_order_items
      set reserved_quantity = greatest(0, reserved_quantity - moved_quantity)
      where id = source_item.id;
      update public.sales_order_items
      set reserved_quantity = reserved_quantity + moved_quantity
      where id = target_item.id;
      remaining_quantity := remaining_quantity - moved_quantity;
    end if;
    exit when remaining_quantity <= 0;
  end loop;

  insert into public.audit_log (actor_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (
    auth.uid(), 'inventory_allocation', target_item.id, 'reallocated',
    jsonb_build_object('from_order_item_id', source_item.id, 'quantity', p_quantity),
    jsonb_build_object('to_order_item_id', target_item.id, 'quantity', p_quantity),
    nullif(trim(p_reason), '')
  );
end;
$$;

-- Al registrar producción, la nueva existencia se asigna por prioridad a los
-- pedidos que todavía tienen faltantes.
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
    perform private.auto_allocate_product(p_product_id);
  end if;
  return batch_id;
end;
$$;

drop function if exists public.create_shipment(uuid, timestamptz, uuid, uuid, numeric, numeric, text, text);

create function public.create_shipment(
  p_sales_order_id uuid,
  p_scheduled_at timestamptz,
  p_vehicle_id uuid,
  p_driver_id uuid,
  p_freight_cost numeric,
  p_freight_charge numeric,
  p_recipient_name text,
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
  order_record public.sales_orders%rowtype;
  delivery_group_id uuid;
  shipment_id uuid;
  item_input record;
  order_item public.sales_order_items%rowtype;
  scheduled_quantity numeric(14,3);
  reserved_quantity numeric(14,3);
  delivery_day date;
  delivery_status text;
begin
  if current_user_id is null or not private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para programar despachos';
  end if;
  if p_scheduled_at is null or coalesce(p_freight_cost, 0) < 0 or coalesce(p_freight_charge, 0) < 0 then
    raise exception 'Completa fecha y montos de flete válidos';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Selecciona al menos un producto para este despacho';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as item(sales_order_item_id uuid, quantity numeric)
    group by sales_order_item_id having count(*) > 1
  ) then
    raise exception 'No repitas un producto dentro del mismo despacho';
  end if;

  select * into order_record from public.sales_orders where id = p_sales_order_id for update;
  if order_record.id is null or order_record.status not in ('ready_for_dispatch'::public.sales_order_status, 'partially_delivered'::public.sales_order_status) then
    raise exception 'El pedido no está autorizado para despacho';
  end if;
  if order_record.delivery_site_id is null then
    raise exception 'El pedido no tiene dirección de entrega';
  end if;
  if p_vehicle_id is not null and not exists (select 1 from public.vehicles where id = p_vehicle_id and is_active = true) then
    raise exception 'El vehículo no está disponible';
  end if;
  if p_driver_id is not null and not exists (select 1 from public.drivers where id = p_driver_id and is_active = true) then
    raise exception 'El piloto no está disponible';
  end if;

  for item_input in select * from jsonb_to_recordset(p_items) as item(sales_order_item_id uuid, quantity numeric)
  loop
    if item_input.sales_order_item_id is null or item_input.quantity is null or item_input.quantity <= 0 then
      raise exception 'Las cantidades del despacho deben ser mayores que cero';
    end if;
    select * into order_item from public.sales_order_items where id = item_input.sales_order_item_id for update;
    if order_item.id is null or order_item.sales_order_id <> order_record.id then
      raise exception 'Uno de los productos no pertenece al pedido';
    end if;
    select coalesce(sum(shipment_item.loaded_quantity), 0) into scheduled_quantity
    from public.shipment_items as shipment_item
    inner join public.shipments as shipment on shipment.id = shipment_item.shipment_id
    where shipment_item.sales_order_item_id = order_item.id
      and shipment.status in ('planned'::public.shipment_status, 'loaded'::public.shipment_status, 'in_transit'::public.shipment_status);
    select coalesce(sum(quantity), 0) into reserved_quantity
    from public.inventory_allocations
    where sales_order_item_id = order_item.id and status = 'reserved';
    if item_input.quantity > order_item.ordered_quantity - order_item.delivered_quantity - scheduled_quantity then
      raise exception 'La cantidad solicitada supera el saldo pendiente del producto %', order_item.description;
    end if;
    if item_input.quantity > reserved_quantity - scheduled_quantity then
      raise exception 'No hay suficiente inventario reservado para despachar %', order_item.description;
    end if;
  end loop;

  delivery_day := (p_scheduled_at at time zone 'America/Guatemala')::date;
  select id, status into delivery_group_id, delivery_status
  from public.delivery_groups
  where sales_order_id = order_record.id and delivery_date = delivery_day
  for update;
  if delivery_group_id is not null then
    if delivery_status = 'invoiced' then
      raise exception 'La entrega de este día ya fue facturada; programa el flete en una nueva fecha';
    end if;
    update public.delivery_groups
    set status = case when status = 'delivered' then 'planned' else status end,
        updated_at = now()
    where id = delivery_group_id;
  else
    insert into public.delivery_groups (sales_order_id, delivery_date, status, notes, created_by)
    values (order_record.id, delivery_day, 'planned', nullif(trim(p_notes), ''), current_user_id)
    returning id into delivery_group_id;
  end if;

  insert into public.shipments (
    delivery_group_id, delivery_site_id, vehicle_id, driver_id, status, scheduled_at,
    freight_cost, freight_charge, recipient_name, delivery_notes, created_by
  ) values (
    delivery_group_id, order_record.delivery_site_id, p_vehicle_id, p_driver_id, 'planned', p_scheduled_at,
    coalesce(p_freight_cost, 0), coalesce(p_freight_charge, 0),
    nullif(trim(p_recipient_name), ''), nullif(trim(p_notes), ''), current_user_id
  ) returning id into shipment_id;

  for item_input in select * from jsonb_to_recordset(p_items) as item(sales_order_item_id uuid, quantity numeric)
  loop
    insert into public.shipment_items (shipment_id, sales_order_item_id, loaded_quantity)
    values (shipment_id, item_input.sales_order_item_id, item_input.quantity);
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
  order_record public.sales_orders%rowtype;
  quote_record public.quotes%rowtype;
  item_record record;
  allocation_record record;
  consumption_remaining numeric(14,3);
  consumption_quantity numeric(14,3);
  order_complete boolean;
  delivery_complete boolean;
  delivery_notes_value text := nullif(trim(coalesce(p_notes, '')), '');
begin
  if current_user_id is null or not private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para actualizar despachos';
  end if;
  select * into shipment_record from public.shipments where id = p_shipment_id for update;
  if shipment_record.id is null then
    raise exception 'El despacho no existe';
  end if;
  select sales_order.* into order_record
  from public.delivery_groups as delivery_group
  inner join public.sales_orders as sales_order on sales_order.id = delivery_group.sales_order_id
  where delivery_group.id = shipment_record.delivery_group_id
  for update of sales_order;
  if order_record.id is null then
    raise exception 'El despacho no está asociado a un pedido marco';
  end if;

  if shipment_record.status = 'planned'::public.shipment_status and p_next_status = 'loaded'::public.shipment_status then
    update public.shipments set status = p_next_status, loaded_at = now(), delivery_notes = coalesce(delivery_notes_value, delivery_notes) where id = p_shipment_id;
  elsif shipment_record.status = 'loaded'::public.shipment_status and p_next_status = 'in_transit'::public.shipment_status then
    select * into quote_record from public.quotes where id = order_record.quote_id;
    if quote_record.status = 'in_dispatch'::public.quote_status then
      perform public.transition_quote_status(quote_record.id, 'in_route'::public.quote_status, coalesce(delivery_notes_value, 'Primer despacho salió a ruta'));
    end if;
    update public.shipments set status = p_next_status, delivery_notes = coalesce(delivery_notes_value, delivery_notes) where id = p_shipment_id;
    update public.delivery_groups set status = 'in_progress', updated_at = now() where id = shipment_record.delivery_group_id and status = 'planned';
  elsif shipment_record.status = 'in_transit'::public.shipment_status and p_next_status = 'delivered'::public.shipment_status then
    update public.shipments
    set status = p_next_status, delivered_at = now(), delivery_notes = coalesce(delivery_notes_value, delivery_notes)
    where id = p_shipment_id;
    update public.shipment_items set delivered_quantity = loaded_quantity where shipment_id = p_shipment_id;

    for item_record in
      select shipment_item.id as shipment_item_id, shipment_item.loaded_quantity, order_item.id as order_item_id,
        order_item.product_id, order_item.description, order_item.delivered_quantity
      from public.shipment_items as shipment_item
      inner join public.sales_order_items as order_item on order_item.id = shipment_item.sales_order_item_id
      where shipment_item.shipment_id = p_shipment_id
    loop
      update public.sales_order_items
      set delivered_quantity = least(ordered_quantity, delivered_quantity + item_record.loaded_quantity)
      where id = item_record.order_item_id;

      consumption_remaining := item_record.loaded_quantity;
      for allocation_record in
        select * from public.inventory_allocations
        where sales_order_item_id = item_record.order_item_id and status = 'reserved'
        order by created_at, id
        for update
      loop
        consumption_quantity := least(consumption_remaining, allocation_record.quantity);
        if consumption_quantity > 0 then
          update public.inventory_allocations
          set quantity = quantity - consumption_quantity,
              status = case when quantity - consumption_quantity = 0 then 'consumed' else status end,
              updated_at = now()
          where id = allocation_record.id;
          update public.sales_order_items
          set reserved_quantity = greatest(0, reserved_quantity - consumption_quantity)
          where id = item_record.order_item_id;
          insert into public.inventory_movements (
            movement_type, product_id, location_id, quantity, sales_order_item_id, notes, created_by
          ) values (
            'delivery', item_record.product_id, allocation_record.location_id, -consumption_quantity,
            item_record.order_item_id, 'Salida confirmada por entrega ' || shipment_record.shipment_number, current_user_id
          );
          consumption_remaining := consumption_remaining - consumption_quantity;
        end if;
        exit when consumption_remaining <= 0;
      end loop;
      if consumption_remaining > 0 then
        raise exception 'No fue posible consumir la reserva de inventario para %', item_record.description;
      end if;
    end loop;

    select not exists (
      select 1 from public.sales_order_items
      where sales_order_id = order_record.id and delivered_quantity < ordered_quantity
    ) into order_complete;
    update public.sales_orders
    set status = case when order_complete then 'delivered'::public.sales_order_status else 'partially_delivered'::public.sales_order_status end,
        updated_at = now()
    where id = order_record.id;

    select not exists (
      select 1 from public.shipments
      where delivery_group_id = shipment_record.delivery_group_id
        and status not in ('delivered'::public.shipment_status, 'cancelled'::public.shipment_status)
    ) into delivery_complete;
    update public.delivery_groups
    set status = case when delivery_complete then 'delivered' else 'in_progress' end,
        updated_at = now()
    where id = shipment_record.delivery_group_id;

    select * into quote_record from public.quotes where id = order_record.quote_id;
    if order_complete and quote_record.status = 'in_route'::public.quote_status then
      perform public.transition_quote_status(quote_record.id, 'delivered'::public.quote_status, coalesce(delivery_notes_value, 'Todas las entregas parciales fueron confirmadas'));
    end if;

    insert into public.deliveries (
      shipment_id, delivered_at, recipient_name, recipient_signature_url, observations, recorded_by
    ) values (
      p_shipment_id, now(), coalesce(nullif(trim(shipment_record.recipient_name), ''), 'Pendiente de confirmar'),
      shipment_record.recipient_signature_url, coalesce(delivery_notes_value, shipment_record.delivery_notes), current_user_id
    ) on conflict (shipment_id) do update
      set delivered_at = excluded.delivered_at,
          recipient_name = excluded.recipient_name,
          recipient_signature_url = excluded.recipient_signature_url,
          observations = excluded.observations,
          recorded_by = excluded.recorded_by;
  else
    raise exception 'La transición de despacho no corresponde al estado actual';
  end if;
end;
$$;

create or replace function public.create_invoice_from_delivery_group(p_delivery_group_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
  delivery_record public.delivery_groups%rowtype;
  order_record public.sales_orders%rowtype;
  customer_days integer;
  invoice_id uuid;
  item_record record;
  shipment_record record;
  product_total numeric(14,2) := 0;
  tax_total numeric(14,2) := 0;
  freight_total numeric(14,2) := 0;
  line_total_value numeric(14,2);
  line_tax_value numeric(14,2);
  total_invoiced numeric(14,2);
  previous_invoiced numeric(14,2);
  credit_extra numeric(14,2);
  credit_release numeric(14,2);
  all_groups_invoiced boolean;
begin
  if current_user_id is null or not private.has_any_role(array['accounting', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para facturar';
  end if;
  select * into delivery_record from public.delivery_groups where id = p_delivery_group_id for update;
  if delivery_record.id is null or delivery_record.status <> 'delivered' then
    raise exception 'La entrega debe tener todos sus fletes confirmados antes de facturar';
  end if;
  if exists (select 1 from public.invoices where delivery_group_id = delivery_record.id) then
    raise exception 'Esta entrega ya fue facturada';
  end if;
  select * into order_record from public.sales_orders where id = delivery_record.sales_order_id for update;
  select credit_days into customer_days from public.customers where id = order_record.customer_id;

  for item_record in
    select shipment_item.id as shipment_item_id, shipment_item.delivered_quantity, shipment_item.loaded_quantity,
      order_item.description, order_item.ordered_quantity, order_item.line_total, order_item.tax_amount
    from public.shipment_items as shipment_item
    inner join public.shipments as shipment on shipment.id = shipment_item.shipment_id
    inner join public.sales_order_items as order_item on order_item.id = shipment_item.sales_order_item_id
    where shipment.delivery_group_id = delivery_record.id
      and shipment.status = 'delivered'::public.shipment_status
    order by shipment_item.id
  loop
    line_total_value := round(item_record.line_total * coalesce(item_record.delivered_quantity, item_record.loaded_quantity) / item_record.ordered_quantity, 2);
    line_tax_value := round(item_record.tax_amount * coalesce(item_record.delivered_quantity, item_record.loaded_quantity) / item_record.ordered_quantity, 2);
    product_total := product_total + line_total_value;
    tax_total := tax_total + line_tax_value;
  end loop;

  select coalesce(sum(freight_charge), 0) into freight_total
  from public.shipments
  where delivery_group_id = delivery_record.id and status = 'delivered'::public.shipment_status;

  select coalesce(sum(total), 0) into previous_invoiced
  from public.invoices where sales_order_id = order_record.id;

  insert into public.invoices (
    customer_id, sales_order_id, delivery_group_id, status, issue_date, due_date, currency,
    subtotal, tax_amount, total, created_by
  ) values (
    order_record.customer_id, order_record.id, delivery_record.id, 'issued', current_date,
    current_date + case when lower(trim(order_record.payment_terms)) in ('crédito', 'credito') then customer_days else 0 end,
    order_record.currency, product_total, tax_total, product_total + freight_total, current_user_id
  ) returning id into invoice_id;

  for item_record in
    select shipment_item.id as shipment_item_id, shipment_item.delivered_quantity, shipment_item.loaded_quantity,
      order_item.description, order_item.ordered_quantity, order_item.line_total, order_item.tax_amount
    from public.shipment_items as shipment_item
    inner join public.shipments as shipment on shipment.id = shipment_item.shipment_id
    inner join public.sales_order_items as order_item on order_item.id = shipment_item.sales_order_item_id
    where shipment.delivery_group_id = delivery_record.id
      and shipment.status = 'delivered'::public.shipment_status
    order by shipment_item.id
  loop
    line_total_value := round(item_record.line_total * coalesce(item_record.delivered_quantity, item_record.loaded_quantity) / item_record.ordered_quantity, 2);
    line_tax_value := round(item_record.tax_amount * coalesce(item_record.delivered_quantity, item_record.loaded_quantity) / item_record.ordered_quantity, 2);
    insert into public.invoice_items (invoice_id, shipment_item_id, description, quantity, unit_price, tax_amount, line_total)
    values (
      invoice_id, item_record.shipment_item_id, item_record.description,
      coalesce(item_record.delivered_quantity, item_record.loaded_quantity),
      round(line_total_value / coalesce(item_record.delivered_quantity, item_record.loaded_quantity), 2),
      line_tax_value, line_total_value
    );
  end loop;
  for shipment_record in
    select shipment_number, freight_charge
    from public.shipments
    where delivery_group_id = delivery_record.id
      and status = 'delivered'::public.shipment_status
      and freight_charge > 0
    order by shipment_number
  loop
    insert into public.invoice_items (invoice_id, description, quantity, unit_price, tax_amount, line_total)
    values (invoice_id, 'FLETE - ' || shipment_record.shipment_number, 1, shipment_record.freight_charge, 0, shipment_record.freight_charge);
  end loop;

  total_invoiced := previous_invoiced + product_total + freight_total;
  if lower(trim(order_record.payment_terms)) in ('crédito', 'credito') then
    credit_extra := greatest(0, total_invoiced - greatest(order_record.total, previous_invoiced));
    if credit_extra > 0 then
      if exists (
        select 1 from public.customers
        where id = order_record.customer_id and credit_used + credit_extra > credit_limit
      ) then
        raise exception 'El flete real supera el crédito disponible del cliente';
      end if;
      update public.customers set credit_used = credit_used + credit_extra, updated_at = now() where id = order_record.customer_id;
      update public.sales_orders set credit_reserved_amount = credit_reserved_amount + credit_extra where id = order_record.id;
    end if;
  end if;

  update public.delivery_groups set status = 'invoiced', updated_at = now() where id = delivery_record.id;
  update public.sales_orders
  set actual_freight_amount = actual_freight_amount + freight_total,
      status = case when status = 'delivered'::public.sales_order_status then 'invoiced'::public.sales_order_status else status end,
      updated_at = now()
  where id = order_record.id;

  select not exists (
    select 1 from public.delivery_groups
    where sales_order_id = order_record.id and status <> 'invoiced'
  ) into all_groups_invoiced;
  if all_groups_invoiced and lower(trim(order_record.payment_terms)) in ('crédito', 'credito') and total_invoiced < order_record.total then
    credit_release := least(order_record.total - total_invoiced, order_record.credit_reserved_amount);
    if credit_release > 0 then
      update public.customers set credit_used = greatest(0, credit_used - credit_release), updated_at = now() where id = order_record.customer_id;
      update public.sales_orders set credit_reserved_amount = greatest(0, credit_reserved_amount - credit_release) where id = order_record.id;
    end if;
  end if;
  return invoice_id;
end;
$$;

create or replace function public.get_order_fulfillment(p_sales_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
  order_record public.sales_orders%rowtype;
begin
  select * into order_record from public.sales_orders where id = p_sales_order_id;
  if current_user_id is null or order_record.id is null then
    raise exception 'Pedido no disponible';
  end if;
  if order_record.seller_id <> current_user_id
    and not private.has_any_role(array['dispatch', 'plant', 'accounting', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para consultar este pedido';
  end if;

  return jsonb_build_object(
    'order', jsonb_build_object(
      'id', order_record.id, 'orderNumber', order_record.order_number,
      'status', order_record.status, 'priorityLevel', order_record.priority_level,
      'estimatedFreight', order_record.freight_amount, 'actualFreight', order_record.actual_freight_amount
    ),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', order_item.id, 'productId', order_item.product_id, 'description', order_item.description,
        'orderedQuantity', order_item.ordered_quantity, 'deliveredQuantity', order_item.delivered_quantity,
        'reservedQuantity', coalesce(reserved.quantity, 0),
        'scheduledQuantity', coalesce(scheduled.quantity, 0),
        'dispatchableQuantity', greatest(0, coalesce(reserved.quantity, 0) - coalesce(scheduled.quantity, 0)),
        'productionRequired', greatest(0, order_item.ordered_quantity - order_item.delivered_quantity - coalesce(reserved.quantity, 0))
      ) order by order_item.line_number)
      from public.sales_order_items as order_item
      left join lateral (
        select sum(quantity) as quantity from public.inventory_allocations
        where sales_order_item_id = order_item.id and status = 'reserved'
      ) as reserved on true
      left join lateral (
        select sum(shipment_item.loaded_quantity) as quantity
        from public.shipment_items as shipment_item
        inner join public.shipments as shipment on shipment.id = shipment_item.shipment_id
        where shipment_item.sales_order_item_id = order_item.id
          and shipment.status in ('planned'::public.shipment_status, 'loaded'::public.shipment_status, 'in_transit'::public.shipment_status)
      ) as scheduled on true
      where order_item.sales_order_id = order_record.id
    ), '[]'::jsonb)
  );
end;
$$;

alter table public.delivery_groups enable row level security;
alter table public.inventory_allocations enable row level security;

drop policy if exists "delivery groups: authorized read" on public.delivery_groups;
create policy "delivery groups: authorized read" on public.delivery_groups for select to authenticated
  using (
    private.has_any_role(array['dispatch', 'plant', 'accounting', 'admin', 'manager']::public.app_role[])
    or exists (select 1 from public.sales_orders where id = sales_order_id and seller_id = auth.uid())
  );
drop policy if exists "allocations: authorized read" on public.inventory_allocations;
create policy "allocations: authorized read" on public.inventory_allocations for select to authenticated
  using (
    private.has_any_role(array['dispatch', 'plant', 'accounting', 'admin', 'manager']::public.app_role[])
    or exists (
      select 1 from public.sales_order_items as order_item
      inner join public.sales_orders as sales_order on sales_order.id = order_item.sales_order_id
      where order_item.id = sales_order_item_id and sales_order.seller_id = auth.uid()
    )
  );

revoke all on function public.get_product_availability(uuid[]) from public;
grant execute on function public.get_product_availability(uuid[]) to authenticated;
revoke all on function public.get_order_fulfillment(uuid) from public;
grant execute on function public.get_order_fulfillment(uuid) to authenticated;
revoke all on function public.set_sales_order_priority(uuid, integer) from public;
grant execute on function public.set_sales_order_priority(uuid, integer) to authenticated;
revoke all on function public.reallocate_inventory_reservation(uuid, uuid, numeric, text) from public;
grant execute on function public.reallocate_inventory_reservation(uuid, uuid, numeric, text) to authenticated;
revoke all on function public.record_production_batch(uuid, uuid, date, text, numeric, numeric, text) from public;
grant execute on function public.record_production_batch(uuid, uuid, date, text, numeric, numeric, text) to authenticated;
revoke all on function public.create_shipment(uuid, timestamptz, uuid, uuid, numeric, numeric, text, text, jsonb) from public;
grant execute on function public.create_shipment(uuid, timestamptz, uuid, uuid, numeric, numeric, text, text, jsonb) to authenticated;
revoke all on function public.advance_shipment_status(uuid, public.shipment_status, text) from public;
grant execute on function public.advance_shipment_status(uuid, public.shipment_status, text) to authenticated;
revoke all on function public.create_invoice_from_delivery_group(uuid) from public;
grant execute on function public.create_invoice_from_delivery_group(uuid) to authenticated;

notify pgrst, 'reload schema';
