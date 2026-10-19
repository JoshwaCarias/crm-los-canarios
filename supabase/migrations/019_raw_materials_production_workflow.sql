-- Materia prima y flujo controlado de fabricación.
-- Ejecutar después de 018b_warehouse_role.sql.
-- Un lote fresco o en curado no genera inventario vendible. Sólo se libera
-- como producto terminado cuando Planta confirma que terminó su curado.

create table if not exists public.raw_materials (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  unit text not null default 'kg',
  minimum_stock numeric(14,3) not null default 0 check (minimum_stock >= 0),
  last_unit_cost numeric(14,2) check (last_unit_cost is null or last_unit_cost >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_material_requirements (
  product_id uuid not null references public.products(id) on delete cascade,
  raw_material_id uuid not null references public.raw_materials(id),
  quantity_per_unit numeric(14,4) not null check (quantity_per_unit > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, raw_material_id)
);

create table if not exists public.raw_material_movements (
  id uuid primary key default gen_random_uuid(),
  raw_material_id uuid not null references public.raw_materials(id),
  location_id uuid not null references public.inventory_locations(id),
  movement_type text not null check (movement_type in ('purchase', 'consumption', 'adjustment', 'return', 'transfer_in', 'transfer_out')),
  quantity numeric(14,3) not null check (quantity <> 0),
  unit_cost numeric(14,2) check (unit_cost is null or unit_cost >= 0),
  supplier text,
  reference text,
  production_batch_id uuid references public.production_batches(id),
  notes text,
  created_by uuid not null references public.profiles(id),
  occurred_at timestamptz not null default now()
);

alter table public.production_batches
  add column if not exists material_location_id uuid references public.inventory_locations(id),
  add column if not exists manufacturing_status text not null default 'ready',
  add column if not exists curing_hours integer not null default 24,
  add column if not exists fresh_at timestamptz,
  add column if not exists curing_started_at timestamptz,
  add column if not exists ready_at timestamptz,
  add column if not exists released_at timestamptz,
  add column if not exists released_by uuid references public.profiles(id);

alter table public.production_batches
  drop constraint if exists production_batches_manufacturing_status_check;
alter table public.production_batches
  add constraint production_batches_manufacturing_status_check
  check (manufacturing_status in ('fresh', 'curing', 'ready', 'rejected', 'cancelled'));
alter table public.production_batches
  drop constraint if exists production_batches_curing_hours_check;
alter table public.production_batches
  add constraint production_batches_curing_hours_check check (curing_hours between 1 and 720);

update public.production_batches
set fresh_at = coalesce(fresh_at, created_at),
    ready_at = coalesce(ready_at, created_at),
    released_at = coalesce(released_at, created_at)
where manufacturing_status = 'ready'
  and (fresh_at is null or ready_at is null or released_at is null);

create index if not exists raw_material_movements_material_location_idx
  on public.raw_material_movements (raw_material_id, location_id, occurred_at);
create index if not exists raw_material_movements_batch_idx
  on public.raw_material_movements (production_batch_id);
create index if not exists production_batches_workflow_idx
  on public.production_batches (manufacturing_status, ready_at);

create or replace view public.raw_material_stock
with (security_invoker = true)
as
select
  material.id as raw_material_id,
  movement.location_id,
  coalesce(sum(movement.quantity), 0)::numeric(14,3) as quantity
from public.raw_materials as material
inner join public.raw_material_movements as movement on movement.raw_material_id = material.id
group by material.id, movement.location_id;

grant select on public.raw_material_stock to authenticated;

alter table public.raw_materials enable row level security;
alter table public.product_material_requirements enable row level security;
alter table public.raw_material_movements enable row level security;

drop policy if exists "raw materials: operation read" on public.raw_materials;
create policy "raw materials: operation read" on public.raw_materials for select to authenticated
  using (private.has_any_role(array['plant', 'warehouse', 'dispatch', 'admin', 'manager']::public.app_role[]));
drop policy if exists "material requirements: operation read" on public.product_material_requirements;
create policy "material requirements: operation read" on public.product_material_requirements for select to authenticated
  using (private.has_any_role(array['plant', 'warehouse', 'dispatch', 'admin', 'manager']::public.app_role[]));
drop policy if exists "raw material movements: operation read" on public.raw_material_movements;
create policy "raw material movements: operation read" on public.raw_material_movements for select to authenticated
  using (private.has_any_role(array['plant', 'warehouse', 'dispatch', 'admin', 'manager']::public.app_role[]));

drop policy if exists "batches: operation read" on public.production_batches;
create policy "batches: operation read" on public.production_batches for select to authenticated
  using (private.has_any_role(array['plant', 'warehouse', 'dispatch', 'admin', 'manager']::public.app_role[]));
drop policy if exists "batches: plant write" on public.production_batches;
drop policy if exists "inventory: operation read" on public.inventory_movements;
create policy "inventory: operation read" on public.inventory_movements for select to authenticated
  using (private.has_any_role(array['plant', 'warehouse', 'dispatch', 'admin', 'manager']::public.app_role[]));
drop policy if exists "inventory: operation write" on public.inventory_movements;

create or replace function public.create_raw_material(
  p_sku text,
  p_name text,
  p_unit text,
  p_minimum_stock numeric default 0
)
returns uuid
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  material_id uuid;
begin
  if auth.uid() is null or not private.has_any_role(array['admin', 'manager']::public.app_role[]) then
    raise exception 'Sólo Administración o Gerencia puede crear materias primas';
  end if;
  if nullif(trim(p_sku), '') is null or nullif(trim(p_name), '') is null
    or nullif(trim(p_unit), '') is null or coalesce(p_minimum_stock, 0) < 0 then
    raise exception 'Completa código, nombre, unidad y stock mínimo válidos';
  end if;

  insert into public.raw_materials (sku, name, unit, minimum_stock)
  values (upper(trim(p_sku)), trim(p_name), lower(trim(p_unit)), coalesce(p_minimum_stock, 0))
  returning id into material_id;

  return material_id;
end;
$$;

create or replace function public.receive_raw_material(
  p_raw_material_id uuid,
  p_location_id uuid,
  p_quantity numeric,
  p_unit_cost numeric default null,
  p_supplier text default null,
  p_reference text default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  movement_id uuid;
begin
  if auth.uid() is null or not private.has_any_role(array['plant', 'warehouse', 'dispatch', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para recibir materia prima';
  end if;
  if p_quantity is null or p_quantity <= 0 or (p_unit_cost is not null and p_unit_cost < 0) then
    raise exception 'La cantidad y el costo unitario deben ser válidos';
  end if;
  if not exists (select 1 from public.raw_materials where id = p_raw_material_id and is_active = true)
    or not exists (select 1 from public.inventory_locations where id = p_location_id and is_active = true) then
    raise exception 'La materia prima o la ubicación no están disponibles';
  end if;

  insert into public.raw_material_movements (
    raw_material_id, location_id, movement_type, quantity, unit_cost,
    supplier, reference, notes, created_by
  ) values (
    p_raw_material_id, p_location_id, 'purchase', p_quantity, p_unit_cost,
    nullif(trim(p_supplier), ''), nullif(trim(p_reference), ''), nullif(trim(p_notes), ''), auth.uid()
  ) returning id into movement_id;

  if p_unit_cost is not null then
    update public.raw_materials set last_unit_cost = p_unit_cost, updated_at = now()
    where id = p_raw_material_id;
  end if;

  return movement_id;
end;
$$;

create or replace function public.set_product_material_requirement(
  p_product_id uuid,
  p_raw_material_id uuid,
  p_quantity_per_unit numeric
)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
begin
  if auth.uid() is null or not private.has_any_role(array['admin', 'manager']::public.app_role[]) then
    raise exception 'Sólo Administración o Gerencia puede definir fórmulas';
  end if;
  if p_quantity_per_unit is null or p_quantity_per_unit <= 0
    or not exists (select 1 from public.products where id = p_product_id and is_active = true)
    or not exists (select 1 from public.raw_materials where id = p_raw_material_id and is_active = true) then
    raise exception 'Producto, materia prima o cantidad por unidad inválidos';
  end if;

  insert into public.product_material_requirements (product_id, raw_material_id, quantity_per_unit)
  values (p_product_id, p_raw_material_id, p_quantity_per_unit)
  on conflict (product_id, raw_material_id) do update
  set quantity_per_unit = excluded.quantity_per_unit, updated_at = now();
end;
$$;

create or replace function public.remove_product_material_requirement(
  p_product_id uuid,
  p_raw_material_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
begin
  if auth.uid() is null or not private.has_any_role(array['admin', 'manager']::public.app_role[]) then
    raise exception 'Sólo Administración o Gerencia puede modificar fórmulas';
  end if;
  delete from public.product_material_requirements
  where product_id = p_product_id and raw_material_id = p_raw_material_id;
end;
$$;

create or replace function public.start_production_batch(
  p_product_id uuid,
  p_product_location_id uuid,
  p_material_location_id uuid,
  p_production_date date,
  p_shift text,
  p_quantity_produced numeric,
  p_quantity_rejected numeric,
  p_curing_hours integer,
  p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  batch_id uuid;
  material_requirement record;
  available_quantity numeric(14,3);
  required_quantity numeric(14,3);
  accepted_quantity numeric(14,3);
  next_status text;
begin
  if auth.uid() is null or not private.has_any_role(array['plant', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para iniciar producción';
  end if;
  if p_quantity_produced is null or p_quantity_produced <= 0
    or coalesce(p_quantity_rejected, 0) < 0 or coalesce(p_quantity_rejected, 0) > p_quantity_produced
    or coalesce(p_curing_hours, 0) not between 1 and 720 then
    raise exception 'Verifica cantidades y horas de curado (de 1 a 720)';
  end if;
  if not exists (select 1 from public.products where id = p_product_id and is_active = true)
    or not exists (select 1 from public.inventory_locations where id = p_product_location_id and is_active = true)
    or not exists (select 1 from public.inventory_locations where id = p_material_location_id and is_active = true) then
    raise exception 'El producto o una de las ubicaciones no están disponibles';
  end if;
  if not exists (select 1 from public.product_material_requirements where product_id = p_product_id) then
    raise exception 'Configura primero la fórmula de materia prima para este producto';
  end if;

  for material_requirement in
    select formula.raw_material_id, formula.quantity_per_unit, material.name, material.unit
    from public.product_material_requirements as formula
    inner join public.raw_materials as material on material.id = formula.raw_material_id
    where formula.product_id = p_product_id
  loop
    required_quantity := round(material_requirement.quantity_per_unit * p_quantity_produced, 3);
    select coalesce(sum(quantity), 0) into available_quantity
    from public.raw_material_movements
    where raw_material_id = material_requirement.raw_material_id and location_id = p_material_location_id;
    if available_quantity < required_quantity then
      raise exception 'No hay suficiente % en la ubicación elegida. Requiere % % y hay % %',
        material_requirement.name, required_quantity, material_requirement.unit, available_quantity, material_requirement.unit;
    end if;
  end loop;

  accepted_quantity := p_quantity_produced - coalesce(p_quantity_rejected, 0);
  next_status := case when accepted_quantity > 0 then 'fresh' else 'rejected' end;
  insert into public.production_batches (
    batch_number, product_id, location_id, material_location_id, production_date, shift,
    quantity_produced, quantity_rejected, notes, created_by, manufacturing_status,
    curing_hours, fresh_at
  ) values (
    'LOT-' || to_char(coalesce(p_production_date, current_date), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 5),
    p_product_id, p_product_location_id, p_material_location_id, coalesce(p_production_date, current_date), nullif(trim(p_shift), ''),
    p_quantity_produced, coalesce(p_quantity_rejected, 0), nullif(trim(p_notes), ''), auth.uid(), next_status,
    p_curing_hours, now()
  ) returning id into batch_id;

  for material_requirement in
    select raw_material_id, quantity_per_unit
    from public.product_material_requirements
    where product_id = p_product_id
  loop
    insert into public.raw_material_movements (
      raw_material_id, location_id, movement_type, quantity, production_batch_id, notes, created_by
    ) values (
      material_requirement.raw_material_id, p_material_location_id, 'consumption',
      -round(material_requirement.quantity_per_unit * p_quantity_produced, 3), batch_id,
      'Consumo automático al iniciar el lote', auth.uid()
    );
  end loop;

  insert into public.audit_log (actor_id, entity_type, entity_id, action, after_data)
  values (auth.uid(), 'production_batch', batch_id, 'started', jsonb_build_object('status', next_status, 'quantity', p_quantity_produced));
  return batch_id;
end;
$$;

create or replace function public.begin_production_batch_curing(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  batch_record public.production_batches%rowtype;
begin
  if auth.uid() is null or not private.has_any_role(array['plant', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para iniciar el curado';
  end if;
  select * into batch_record from public.production_batches where id = p_batch_id for update;
  if batch_record.id is null or batch_record.manufacturing_status <> 'fresh' then
    raise exception 'Sólo un lote fresco puede pasar a curado';
  end if;
  update public.production_batches
  set manufacturing_status = 'curing', curing_started_at = now(),
      ready_at = now() + make_interval(hours => curing_hours)
  where id = p_batch_id;
  insert into public.audit_log (actor_id, entity_type, entity_id, action, after_data)
  values (auth.uid(), 'production_batch', p_batch_id, 'curing_started', jsonb_build_object('curing_hours', batch_record.curing_hours));
end;
$$;

create or replace function public.release_production_batch(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  batch_record public.production_batches%rowtype;
  accepted_quantity numeric(14,3);
begin
  if auth.uid() is null or not private.has_any_role(array['plant', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para liberar producto terminado';
  end if;
  select * into batch_record from public.production_batches where id = p_batch_id for update;
  if batch_record.id is null or batch_record.manufacturing_status <> 'curing' then
    raise exception 'Sólo un lote en curado puede liberarse como producto terminado';
  end if;
  if batch_record.ready_at is null or batch_record.ready_at > now() then
    raise exception 'El lote aún está en curado y no puede venderse hasta %', batch_record.ready_at;
  end if;
  accepted_quantity := batch_record.quantity_produced - batch_record.quantity_rejected;
  if accepted_quantity > 0 and exists (
    select 1 from public.inventory_movements
    where production_batch_id = batch_record.id and movement_type = 'production'::public.inventory_movement_type
  ) then
    raise exception 'Este lote ya tiene un ingreso de inventario registrado';
  end if;
  if accepted_quantity > 0 then
    insert into public.inventory_movements (
      movement_type, product_id, location_id, quantity, production_batch_id, notes, created_by
    ) values (
      'production', batch_record.product_id, batch_record.location_id, accepted_quantity, batch_record.id,
      'Lote curado y liberado como producto terminado', auth.uid()
    );
  end if;
  update public.production_batches
  set manufacturing_status = 'ready', ready_at = coalesce(ready_at, now()), released_at = now(), released_by = auth.uid(),
      quality_approved_by = auth.uid(), quality_approved_at = now()
  where id = p_batch_id;
  perform private.auto_allocate_product(batch_record.product_id);
  insert into public.audit_log (actor_id, entity_type, entity_id, action, after_data)
  values (auth.uid(), 'production_batch', p_batch_id, 'released_for_sale', jsonb_build_object('accepted_quantity', accepted_quantity));
end;
$$;

-- Conserva compatibilidad con la función usada por la primera versión, pero
-- ahora inicia el flujo de lote fresco en vez de agregar producto vendible.
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
begin
  return public.start_production_batch(
    p_product_id, p_location_id, p_location_id, p_production_date, p_shift,
    p_quantity_produced, p_quantity_rejected, 24, p_notes
  );
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
    and not private.has_any_role(array['dispatch', 'plant', 'warehouse', 'accounting', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para consultar este pedido';
  end if;
  return jsonb_build_object(
    'order', jsonb_build_object(
      'id', order_record.id, 'orderNumber', order_record.order_number,
      'status', order_record.status, 'estimatedFreight', order_record.freight_amount,
      'actualFreight', order_record.actual_freight_amount
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

revoke all on function public.create_raw_material(text, text, text, numeric) from public;
grant execute on function public.create_raw_material(text, text, text, numeric) to authenticated;
revoke all on function public.receive_raw_material(uuid, uuid, numeric, numeric, text, text, text) from public;
grant execute on function public.receive_raw_material(uuid, uuid, numeric, numeric, text, text, text) to authenticated;
revoke all on function public.set_product_material_requirement(uuid, uuid, numeric) from public;
grant execute on function public.set_product_material_requirement(uuid, uuid, numeric) to authenticated;
revoke all on function public.remove_product_material_requirement(uuid, uuid) from public;
grant execute on function public.remove_product_material_requirement(uuid, uuid) to authenticated;
revoke all on function public.start_production_batch(uuid, uuid, uuid, date, text, numeric, numeric, integer, text) from public;
grant execute on function public.start_production_batch(uuid, uuid, uuid, date, text, numeric, numeric, integer, text) to authenticated;
revoke all on function public.begin_production_batch_curing(uuid) from public;
grant execute on function public.begin_production_batch_curing(uuid) to authenticated;
revoke all on function public.release_production_batch(uuid) from public;
grant execute on function public.release_production_batch(uuid) to authenticated;
revoke all on function public.record_production_batch(uuid, uuid, date, text, numeric, numeric, text) from public;
grant execute on function public.record_production_batch(uuid, uuid, date, text, numeric, numeric, text) to authenticated;
revoke all on function public.get_order_fulfillment(uuid) from public;
grant execute on function public.get_order_fulfillment(uuid) to authenticated;

notify pgrst, 'reload schema';
