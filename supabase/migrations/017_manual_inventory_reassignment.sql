-- La asignación de inventario sigue el orden de creación del pedido.
-- La reasignación por urgencia es una decisión manual de Administración o
-- Logística mediante reallocate_inventory_reservation; no existe prioridad
-- automática visible para los usuarios.
-- Ejecutar después de 016_partial_deliveries_inventory.sql.

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
    order by sales_order.created_at asc, order_item.line_number asc
  loop
    perform private.auto_allocate_order_item(item_record.id);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
