-- Corrige la variable de recorrido de la fórmula al iniciar un lote.
-- Ejecutar después de 019_raw_materials_production_workflow.sql.

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

revoke all on function public.start_production_batch(uuid, uuid, uuid, date, text, numeric, numeric, integer, text) from public;
grant execute on function public.start_production_batch(uuid, uuid, uuid, date, text, numeric, numeric, integer, text) to authenticated;

notify pgrst, 'reload schema';
