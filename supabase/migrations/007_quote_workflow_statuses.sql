-- Parte 1 del flujo de cotizaciones.
-- Ejecutar este archivo por separado y esperar a que finalice antes de ejecutar
-- 008_quote_workflow.sql. PostgreSQL requiere confirmar los nuevos valores de
-- un enum antes de utilizarlos en las funciones y actualizaciones posteriores.

alter type public.quote_status add value if not exists 'pending_admin_approval';
alter type public.quote_status add value if not exists 'approved' after 'pending_admin_approval';
alter type public.quote_status add value if not exists 'in_production';
alter type public.quote_status add value if not exists 'pending_dispatch_authorization';
alter type public.quote_status add value if not exists 'in_dispatch';
alter type public.quote_status add value if not exists 'in_route';
alter type public.quote_status add value if not exists 'delivered';
