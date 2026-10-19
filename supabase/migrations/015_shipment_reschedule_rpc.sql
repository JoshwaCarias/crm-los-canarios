-- Permite reprogramar un despacho antes de iniciar su carga.
-- Ejecutar después de 014_quote_status_approved_fix.sql.

create or replace function public.reschedule_shipment(
  p_shipment_id uuid,
  p_scheduled_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
  shipment_record public.shipments%rowtype;
begin
  if current_user_id is null or not private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para reprogramar despachos';
  end if;
  if p_scheduled_at is null then
    raise exception 'Indica una nueva fecha y hora de carga';
  end if;

  select * into shipment_record
  from public.shipments
  where id = p_shipment_id
  for update;

  if shipment_record.id is null then
    raise exception 'El despacho no existe';
  end if;
  if shipment_record.status <> 'planned'::public.shipment_status then
    raise exception 'Sólo se puede reprogramar un despacho que aún no ha sido cargado';
  end if;

  update public.shipments
  set scheduled_at = p_scheduled_at
  where id = p_shipment_id;

  insert into public.audit_log (actor_id, entity_type, entity_id, action, before_data, after_data)
  values (
    current_user_id,
    'shipment',
    p_shipment_id,
    'rescheduled',
    jsonb_build_object('scheduled_at', shipment_record.scheduled_at),
    jsonb_build_object('scheduled_at', p_scheduled_at)
  );
end;
$$;

revoke all on function public.reschedule_shipment(uuid, timestamptz) from public;
grant execute on function public.reschedule_shipment(uuid, timestamptz) to authenticated;

notify pgrst, 'reload schema';
