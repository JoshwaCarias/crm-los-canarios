-- Metas comerciales mensuales por vendedor.
-- Ejecutar después de 010_orders_dispatch_production_finance.sql.

create table if not exists public.sales_targets (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles(id),
  target_month date not null check (target_month = date_trunc('month', target_month)::date),
  sales_target numeric(14,2) not null default 0 check (sales_target >= 0),
  quote_target integer not null default 0 check (quote_target >= 0),
  notes text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (seller_id, target_month)
);

alter table public.sales_targets enable row level security;

drop policy if exists "sales targets: read own or leadership" on public.sales_targets;
create policy "sales targets: read own or leadership" on public.sales_targets for select to authenticated
  using (
    seller_id = auth.uid()
    or private.has_any_role(array['admin', 'manager']::public.app_role[])
  );
drop policy if exists "sales targets: leadership write" on public.sales_targets;
create policy "sales targets: leadership write" on public.sales_targets for all to authenticated
  using (private.has_any_role(array['admin', 'manager']::public.app_role[]))
  with check (private.has_any_role(array['admin', 'manager']::public.app_role[]));

create index if not exists sales_targets_month_idx on public.sales_targets (target_month, seller_id);
