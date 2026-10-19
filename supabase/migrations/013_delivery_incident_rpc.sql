-- RPC seguros para que la aplicación Next.js confirme entregas y gestione
-- incidencias mediante Supabase. Ejecutar después de 012.

create or replace function public.confirm_shipment_delivery(
  p_shipment_id uuid,
  p_recipient_name text,
  p_recipient_signature_url text default null,
  p_observations text default null
)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null or not private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para confirmar entregas';
  end if;

  if nullif(trim(coalesce(p_recipient_name, '')), '') is null then
    raise exception 'Indica el nombre de quien recibe la entrega';
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

create or replace function public.register_shipment_incident(
  p_shipment_id uuid,
  p_incident_type text,
  p_description text,
  p_occurred_at timestamptz default now()
)
returns uuid
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

  return incident_id;
end;
$$;

create or replace function public.resolve_shipment_incident(
  p_incident_id uuid,
  p_resolution_notes text
)
returns void
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  current_user_id uuid := auth.uid();
  incident_record public.incidents%rowtype;
begin
  if current_user_id is null or not private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]) then
    raise exception 'No tienes permiso para resolver incidencias';
  end if;

  select * into incident_record
  from public.incidents
  where id = p_incident_id
  for update;

  if incident_record.id is null then
    raise exception 'La incidencia no existe';
  end if;
  if incident_record.status in ('closed'::public.incident_status, 'cancelled'::public.incident_status) then
    raise exception 'La incidencia ya está cerrada';
  end if;
  if char_length(trim(coalesce(p_resolution_notes, ''))) < 5 then
    raise exception 'Describe cómo se resolvió la incidencia';
  end if;

  update public.incidents
  set status = 'closed',
      resolved_at = now(),
      resolved_by = current_user_id,
      resolution_notes = trim(p_resolution_notes),
      updated_at = now()
  where id = p_incident_id;

  insert into public.audit_log (actor_id, entity_type, entity_id, action, after_data)
  values (
    current_user_id,
    'incident',
    p_incident_id,
    'closed',
    jsonb_build_object('status', 'closed', 'resolved_at', now())
  );
end;
$$;

revoke all on function public.confirm_shipment_delivery(uuid, text, text, text) from public;
grant execute on function public.confirm_shipment_delivery(uuid, text, text, text) to authenticated;
revoke all on function public.register_shipment_incident(uuid, text, text, timestamptz) from public;
grant execute on function public.register_shipment_incident(uuid, text, text, timestamptz) to authenticated;
revoke all on function public.resolve_shipment_incident(uuid, text) from public;
grant execute on function public.resolve_shipment_incident(uuid, text) to authenticated;

notify pgrst, 'reload schema';
