-- CRM Los Canarios, S.A. — migración inicial PostgreSQL / Supabase
-- Ejecutar en un proyecto de desarrollo primero. Requiere la extensión pgcrypto.

create extension if not exists pgcrypto;

create type app_role as enum ('seller', 'dispatch', 'plant', 'accounting', 'admin', 'manager');
create type quote_status as enum ('draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled');
create type sales_order_status as enum (
  'draft', 'pending_approval', 'approved', 'pending_fulfillment',
  'ready_for_dispatch', 'partially_delivered', 'delivered', 'invoiced',
  'closed', 'cancelled'
);
create type inventory_movement_type as enum (
  'production', 'reservation', 'reservation_release', 'load', 'delivery',
  'return', 'adjustment', 'transfer_in', 'transfer_out'
);
create type shipment_status as enum ('planned', 'loaded', 'in_transit', 'delivered', 'partially_delivered', 'cancelled');
create type invoice_status as enum ('draft', 'issued', 'partially_paid', 'paid', 'void');
create type payment_method as enum ('cash', 'bank_transfer', 'check', 'card', 'other');

-- auth.users es administrada por Supabase. Nunca se guarda la contraseña aquí.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_roles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  role app_role not null,
  primary key (user_id, role)
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  trade_name text,
  nit text not null unique,
  phone text,
  email text,
  credit_limit numeric(14,2) not null default 0 check (credit_limit >= 0),
  credit_days integer not null default 0 check (credit_days >= 0),
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.customer_contacts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  full_name text not null,
  job_title text,
  phone text,
  email text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.delivery_sites (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  name text not null,
  address text not null,
  municipality text,
  department text,
  latitude numeric(9,6),
  longitude numeric(9,6),
  delivery_notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  description text,
  diameter_mm numeric(10,2),
  length_mm numeric(10,2),
  strength_class text,
  joint_type text,
  unit text not null default 'unidad',
  weight_kg numeric(12,2) check (weight_kg is null or weight_kg >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.price_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  valid_from date not null,
  valid_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from)
);

create table public.price_list_items (
  price_list_id uuid not null references public.price_lists(id) on delete cascade,
  product_id uuid not null references public.products(id),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  primary key (price_list_id, product_id)
);

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  quote_number text not null unique,
  customer_id uuid not null references public.customers(id),
  delivery_site_id uuid references public.delivery_sites(id),
  seller_id uuid not null references public.profiles(id),
  price_list_id uuid references public.price_lists(id),
  status quote_status not null default 'draft',
  issue_date date not null default current_date,
  valid_until date,
  currency char(3) not null default 'GTQ' check (currency = 'GTQ'),
  subtotal numeric(14,2) not null default 0 check (subtotal >= 0),
  discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0),
  tax_amount numeric(14,2) not null default 0 check (tax_amount >= 0),
  total numeric(14,2) not null default 0 check (total >= 0),
  terms text,
  approval_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_until is null or valid_until >= issue_date)
);

create table public.quote_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  line_number integer not null check (line_number > 0),
  product_id uuid not null references public.products(id),
  description text not null,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0),
  tax_amount numeric(14,2) not null default 0 check (tax_amount >= 0),
  line_total numeric(14,2) not null check (line_total >= 0),
  unique (quote_id, line_number)
);

create table public.sales_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  quote_id uuid unique references public.quotes(id),
  customer_id uuid not null references public.customers(id),
  delivery_site_id uuid references public.delivery_sites(id),
  seller_id uuid not null references public.profiles(id),
  status sales_order_status not null default 'draft',
  requested_delivery_date date,
  credit_approved_by uuid references public.profiles(id),
  credit_approved_at timestamptz,
  currency char(3) not null default 'GTQ' check (currency = 'GTQ'),
  subtotal numeric(14,2) not null default 0 check (subtotal >= 0),
  discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0),
  tax_amount numeric(14,2) not null default 0 check (tax_amount >= 0),
  total numeric(14,2) not null default 0 check (total >= 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((credit_approved_at is null) = (credit_approved_by is null))
);

create table public.sales_order_items (
  id uuid primary key default gen_random_uuid(),
  sales_order_id uuid not null references public.sales_orders(id) on delete cascade,
  line_number integer not null check (line_number > 0),
  product_id uuid not null references public.products(id),
  description text not null,
  ordered_quantity numeric(14,3) not null check (ordered_quantity > 0),
  reserved_quantity numeric(14,3) not null default 0 check (reserved_quantity >= 0),
  delivered_quantity numeric(14,3) not null default 0 check (delivered_quantity >= 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0),
  tax_amount numeric(14,2) not null default 0 check (tax_amount >= 0),
  line_total numeric(14,2) not null check (line_total >= 0),
  unique (sales_order_id, line_number),
  check (reserved_quantity <= ordered_quantity),
  check (delivered_quantity <= ordered_quantity)
);

create table public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  sales_order_id uuid not null references public.sales_orders(id),
  previous_status sales_order_status,
  new_status sales_order_status not null,
  changed_by uuid not null references public.profiles(id),
  reason text,
  changed_at timestamptz not null default now()
);

create table public.inventory_locations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  location_type text not null check (location_type in ('plant', 'yard', 'warehouse', 'transit')),
  is_active boolean not null default true
);

create table public.production_batches (
  id uuid primary key default gen_random_uuid(),
  batch_number text not null unique,
  product_id uuid not null references public.products(id),
  location_id uuid not null references public.inventory_locations(id),
  production_date date not null,
  shift text,
  quantity_produced numeric(14,3) not null check (quantity_produced > 0),
  quantity_rejected numeric(14,3) not null default 0 check (quantity_rejected >= 0),
  quality_approved_by uuid references public.profiles(id),
  quality_approved_at timestamptz,
  notes text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  check (quantity_rejected <= quantity_produced),
  check ((quality_approved_at is null) = (quality_approved_by is null))
);

-- El saldo se deriva de esta tabla. No actualizar existencias con una columna editable.
create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  movement_type inventory_movement_type not null,
  product_id uuid not null references public.products(id),
  location_id uuid not null references public.inventory_locations(id),
  quantity numeric(14,3) not null check (quantity <> 0),
  sales_order_item_id uuid references public.sales_order_items(id),
  production_batch_id uuid references public.production_batches(id),
  occurred_at timestamptz not null default now(),
  notes text,
  created_by uuid not null references public.profiles(id),
  reversed_movement_id uuid unique references public.inventory_movements(id)
);

create table public.carriers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  nit text,
  phone text,
  is_external boolean not null default true,
  is_active boolean not null default true
);

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  carrier_id uuid references public.carriers(id),
  plate text not null unique,
  description text,
  capacity_kg numeric(12,2) check (capacity_kg is null or capacity_kg > 0),
  is_active boolean not null default true
);

create table public.drivers (
  id uuid primary key default gen_random_uuid(),
  carrier_id uuid references public.carriers(id),
  full_name text not null,
  license_number text,
  phone text,
  is_active boolean not null default true
);

create table public.shipments (
  id uuid primary key default gen_random_uuid(),
  shipment_number text not null unique,
  delivery_site_id uuid not null references public.delivery_sites(id),
  vehicle_id uuid references public.vehicles(id),
  driver_id uuid references public.drivers(id),
  status shipment_status not null default 'planned',
  scheduled_at timestamptz not null,
  loaded_at timestamptz,
  delivered_at timestamptz,
  freight_cost numeric(14,2) not null default 0 check (freight_cost >= 0),
  freight_charge numeric(14,2) not null default 0 check (freight_charge >= 0),
  recipient_name text,
  recipient_signature_url text,
  delivery_notes text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  check (loaded_at is null or loaded_at >= scheduled_at),
  check (delivered_at is null or delivered_at >= scheduled_at)
);

create table public.shipment_items (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  sales_order_item_id uuid not null references public.sales_order_items(id),
  loaded_quantity numeric(14,3) not null check (loaded_quantity > 0),
  delivered_quantity numeric(14,3) check (delivered_quantity is null or delivered_quantity >= 0),
  unique (shipment_id, sales_order_item_id),
  check (delivered_quantity is null or delivered_quantity <= loaded_quantity)
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  customer_id uuid not null references public.customers(id),
  sales_order_id uuid references public.sales_orders(id),
  status invoice_status not null default 'draft',
  issue_date date,
  due_date date,
  external_fel_id text unique,
  currency char(3) not null default 'GTQ' check (currency = 'GTQ'),
  subtotal numeric(14,2) not null default 0 check (subtotal >= 0),
  tax_amount numeric(14,2) not null default 0 check (tax_amount >= 0),
  total numeric(14,2) not null default 0 check (total >= 0),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  check (due_date is null or issue_date is null or due_date >= issue_date)
);

create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  shipment_item_id uuid references public.shipment_items(id),
  description text not null,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  tax_amount numeric(14,2) not null default 0 check (tax_amount >= 0),
  line_total numeric(14,2) not null check (line_total >= 0)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  invoice_id uuid references public.invoices(id),
  payment_date date not null default current_date,
  method payment_method not null,
  amount numeric(14,2) not null check (amount > 0),
  reference text,
  notes text,
  received_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id),
  entity_type text not null,
  entity_id uuid,
  action text not null,
  before_data jsonb,
  after_data jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create index sales_orders_customer_status_idx on public.sales_orders (customer_id, status);
create index sales_orders_requested_delivery_idx on public.sales_orders (requested_delivery_date);
create index inventory_movements_product_location_idx on public.inventory_movements (product_id, location_id, occurred_at);
create index shipments_status_scheduled_idx on public.shipments (status, scheduled_at);
create index invoices_customer_status_due_idx on public.invoices (customer_id, status, due_date);
create index audit_log_entity_idx on public.audit_log (entity_type, entity_id, created_at desc);

-- Siguiente paso de seguridad (no omitir en producción):
-- 1. Alterar cada tabla pública con ENABLE ROW LEVEL SECURITY.
-- 2. Exponer sólo vistas y funciones para los cambios críticos de estado.
-- 3. Crear políticas por rol y tenant si el producto se reutilizará con otras empresas.
-- 4. Mantener la service_role únicamente en rutas de servidor, nunca en el navegador.
