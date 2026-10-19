-- Seguridad base para la migración 001_crm_schema.sql.
-- Ejecutar en Supabase SQL Editor después de la migración inicial.
-- Esta política es una base de MVP; los cambios críticos de estado deben pasar
-- posteriormente por funciones PostgreSQL o rutas de servidor auditadas.

create schema if not exists private;

create or replace function private.has_any_role(required_roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = auth.uid()
      and role = any(required_roles)
  );
$$;

revoke all on function private.has_any_role(public.app_role[]) from public;
grant usage on schema private to authenticated;
grant execute on function private.has_any_role(public.app_role[]) to authenticated;

-- Todas las tablas quedan denegadas por defecto. Las políticas siguientes
-- conceden el mínimo acceso necesario para esta primera interfaz.
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.customers enable row level security;
alter table public.customer_contacts enable row level security;
alter table public.delivery_sites enable row level security;
alter table public.products enable row level security;
alter table public.price_lists enable row level security;
alter table public.price_list_items enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_items enable row level security;
alter table public.sales_orders enable row level security;
alter table public.sales_order_items enable row level security;
alter table public.order_status_history enable row level security;
alter table public.inventory_locations enable row level security;
alter table public.production_batches enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.carriers enable row level security;
alter table public.vehicles enable row level security;
alter table public.drivers enable row level security;
alter table public.shipments enable row level security;
alter table public.shipment_items enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.payments enable row level security;
alter table public.audit_log enable row level security;

-- Usuario, perfil y roles.
create policy "profiles: read own or privileged" on public.profiles for select to authenticated
  using (id = auth.uid() or private.has_any_role(array['admin', 'manager']::public.app_role[]));
create policy "profiles: manage by admin" on public.profiles for all to authenticated
  using (private.has_any_role(array['admin']::public.app_role[]))
  with check (private.has_any_role(array['admin']::public.app_role[]));

create policy "user_roles: read own or admin" on public.user_roles for select to authenticated
  using (user_id = auth.uid() or private.has_any_role(array['admin']::public.app_role[]));
create policy "user_roles: manage by admin" on public.user_roles for all to authenticated
  using (private.has_any_role(array['admin']::public.app_role[]))
  with check (private.has_any_role(array['admin']::public.app_role[]));

-- Catálogos de consulta común. Sólo administración/gerencia los administra.
create policy "customers: authenticated read" on public.customers for select to authenticated using (true);
create policy "customers: commercial write" on public.customers for all to authenticated
  using (private.has_any_role(array['seller', 'admin', 'manager']::public.app_role[]))
  with check (private.has_any_role(array['seller', 'admin', 'manager']::public.app_role[]));
create policy "contacts: authenticated read" on public.customer_contacts for select to authenticated using (true);
create policy "contacts: commercial write" on public.customer_contacts for all to authenticated
  using (private.has_any_role(array['seller', 'admin', 'manager']::public.app_role[]))
  with check (private.has_any_role(array['seller', 'admin', 'manager']::public.app_role[]));
create policy "sites: authenticated read" on public.delivery_sites for select to authenticated using (true);
create policy "sites: commercial write" on public.delivery_sites for all to authenticated
  using (private.has_any_role(array['seller', 'admin', 'manager']::public.app_role[]))
  with check (private.has_any_role(array['seller', 'admin', 'manager']::public.app_role[]));

create policy "products: authenticated read" on public.products for select to authenticated using (true);
create policy "products: privileged write" on public.products for all to authenticated
  using (private.has_any_role(array['admin', 'manager']::public.app_role[]))
  with check (private.has_any_role(array['admin', 'manager']::public.app_role[]));
create policy "price_lists: authenticated read" on public.price_lists for select to authenticated using (true);
create policy "price_lists: privileged write" on public.price_lists for all to authenticated
  using (private.has_any_role(array['admin', 'manager']::public.app_role[]))
  with check (private.has_any_role(array['admin', 'manager']::public.app_role[]));
create policy "price_list_items: authenticated read" on public.price_list_items for select to authenticated using (true);
create policy "price_list_items: privileged write" on public.price_list_items for all to authenticated
  using (private.has_any_role(array['admin', 'manager']::public.app_role[]))
  with check (private.has_any_role(array['admin', 'manager']::public.app_role[]));

-- Ventas: un vendedor sólo ve y registra sus propios documentos; roles de
-- operación/finanzas pueden consultarlos para cumplir su parte del flujo.
create policy "quotes: read according to role" on public.quotes for select to authenticated
  using (seller_id = auth.uid() or private.has_any_role(array['dispatch', 'accounting', 'admin', 'manager']::public.app_role[]));
create policy "quotes: seller create own" on public.quotes for insert to authenticated
  with check (seller_id = auth.uid() and private.has_any_role(array['seller', 'admin', 'manager']::public.app_role[]));
create policy "quotes: seller update own" on public.quotes for update to authenticated
  using (seller_id = auth.uid() or private.has_any_role(array['admin', 'manager']::public.app_role[]))
  with check (seller_id = auth.uid() or private.has_any_role(array['admin', 'manager']::public.app_role[]));
create policy "quote_items: related quote access" on public.quote_items for select to authenticated
  using (exists (select 1 from public.quotes q where q.id = quote_id));
create policy "quote_items: seller write related quote" on public.quote_items for all to authenticated
  using (exists (select 1 from public.quotes q where q.id = quote_id and (q.seller_id = auth.uid() or private.has_any_role(array['admin', 'manager']::public.app_role[]))))
  with check (exists (select 1 from public.quotes q where q.id = quote_id and (q.seller_id = auth.uid() or private.has_any_role(array['admin', 'manager']::public.app_role[]))));

create policy "orders: read according to role" on public.sales_orders for select to authenticated
  using (seller_id = auth.uid() or private.has_any_role(array['dispatch', 'plant', 'accounting', 'admin', 'manager']::public.app_role[]));
create policy "orders: seller create own" on public.sales_orders for insert to authenticated
  with check (seller_id = auth.uid() and private.has_any_role(array['seller', 'admin', 'manager']::public.app_role[]));
create policy "orders: update authorized role" on public.sales_orders for update to authenticated
  using (seller_id = auth.uid() or private.has_any_role(array['dispatch', 'accounting', 'admin', 'manager']::public.app_role[]))
  with check (seller_id = auth.uid() or private.has_any_role(array['dispatch', 'accounting', 'admin', 'manager']::public.app_role[]));
create policy "order_items: related order access" on public.sales_order_items for select to authenticated
  using (exists (select 1 from public.sales_orders o where o.id = sales_order_id));
create policy "order_items: write authorized order" on public.sales_order_items for all to authenticated
  using (exists (select 1 from public.sales_orders o where o.id = sales_order_id and (o.seller_id = auth.uid() or private.has_any_role(array['dispatch', 'accounting', 'admin', 'manager']::public.app_role[]))))
  with check (exists (select 1 from public.sales_orders o where o.id = sales_order_id and (o.seller_id = auth.uid() or private.has_any_role(array['dispatch', 'accounting', 'admin', 'manager']::public.app_role[]))));
create policy "order_history: read authorized" on public.order_status_history for select to authenticated
  using (exists (select 1 from public.sales_orders o where o.id = sales_order_id));
create policy "order_history: authorized insert" on public.order_status_history for insert to authenticated
  with check (changed_by = auth.uid() and exists (select 1 from public.sales_orders o where o.id = sales_order_id));

-- Operación de planta e inventario.
create policy "locations: authenticated read" on public.inventory_locations for select to authenticated using (true);
create policy "locations: privileged write" on public.inventory_locations for all to authenticated
  using (private.has_any_role(array['admin', 'manager']::public.app_role[]))
  with check (private.has_any_role(array['admin', 'manager']::public.app_role[]));
create policy "batches: operation read" on public.production_batches for select to authenticated
  using (private.has_any_role(array['plant', 'dispatch', 'admin', 'manager']::public.app_role[]));
create policy "batches: plant write" on public.production_batches for all to authenticated
  using (private.has_any_role(array['plant', 'admin', 'manager']::public.app_role[]))
  with check (created_by = auth.uid() and private.has_any_role(array['plant', 'admin', 'manager']::public.app_role[]));
create policy "inventory: operation read" on public.inventory_movements for select to authenticated
  using (private.has_any_role(array['plant', 'dispatch', 'admin', 'manager']::public.app_role[]));
create policy "inventory: operation write" on public.inventory_movements for insert to authenticated
  with check (created_by = auth.uid() and private.has_any_role(array['plant', 'dispatch', 'admin', 'manager']::public.app_role[]));

-- Fletes y despachos.
create policy "carriers: operation read" on public.carriers for select to authenticated
  using (private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]));
create policy "carriers: dispatch write" on public.carriers for all to authenticated
  using (private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]))
  with check (private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]));
create policy "vehicles: operation read" on public.vehicles for select to authenticated
  using (private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]));
create policy "vehicles: dispatch write" on public.vehicles for all to authenticated
  using (private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]))
  with check (private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]));
create policy "drivers: operation read" on public.drivers for select to authenticated
  using (private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]));
create policy "drivers: dispatch write" on public.drivers for all to authenticated
  using (private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]))
  with check (private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]));
create policy "shipments: operation read" on public.shipments for select to authenticated
  using (private.has_any_role(array['dispatch', 'accounting', 'admin', 'manager']::public.app_role[]));
create policy "shipments: dispatch write" on public.shipments for all to authenticated
  using (private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]))
  with check (created_by = auth.uid() and private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[]));
create policy "shipment_items: related shipment access" on public.shipment_items for select to authenticated
  using (exists (select 1 from public.shipments s where s.id = shipment_id));
create policy "shipment_items: dispatch write" on public.shipment_items for all to authenticated
  using (exists (select 1 from public.shipments s where s.id = shipment_id and private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[])))
  with check (exists (select 1 from public.shipments s where s.id = shipment_id and private.has_any_role(array['dispatch', 'admin', 'manager']::public.app_role[])));

-- Finanzas y auditoría.
create policy "invoices: finance read" on public.invoices for select to authenticated
  using (private.has_any_role(array['accounting', 'admin', 'manager']::public.app_role[]));
create policy "invoices: accounting write" on public.invoices for all to authenticated
  using (private.has_any_role(array['accounting', 'admin', 'manager']::public.app_role[]))
  with check (created_by = auth.uid() and private.has_any_role(array['accounting', 'admin', 'manager']::public.app_role[]));
create policy "invoice_items: related invoice access" on public.invoice_items for select to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id));
create policy "invoice_items: accounting write" on public.invoice_items for all to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id and private.has_any_role(array['accounting', 'admin', 'manager']::public.app_role[])))
  with check (exists (select 1 from public.invoices i where i.id = invoice_id and private.has_any_role(array['accounting', 'admin', 'manager']::public.app_role[])));
create policy "payments: finance read" on public.payments for select to authenticated
  using (private.has_any_role(array['accounting', 'admin', 'manager']::public.app_role[]));
create policy "payments: accounting insert" on public.payments for insert to authenticated
  with check (received_by = auth.uid() and private.has_any_role(array['accounting', 'admin', 'manager']::public.app_role[]));
create policy "audit: privileged read" on public.audit_log for select to authenticated
  using (private.has_any_role(array['admin', 'manager']::public.app_role[]));
