-- Corrección de lectura de cotizaciones creadas por el propio vendedor.
-- Ejecutar después de 004_quotes_sales_ownership_followups.sql.

drop policy if exists "quotes: operational roles read" on public.quotes;

create policy "quotes: creator or operational role read" on public.quotes for select to authenticated
  using (
    seller_id = auth.uid()
    or private.has_any_role(array['dispatch', 'plant', 'accounting', 'admin', 'manager']::public.app_role[])
  );
