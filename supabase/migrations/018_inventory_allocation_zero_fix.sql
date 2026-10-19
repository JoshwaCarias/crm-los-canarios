-- Permite cerrar una reserva completamente consumida o reasignada con cantidad 0.
-- Ejecutar después de 017_manual_inventory_reassignment.sql.

alter table public.inventory_allocations
  drop constraint if exists inventory_allocations_quantity_check;

alter table public.inventory_allocations
  add constraint inventory_allocations_quantity_check check (
    (status = 'reserved' and quantity > 0)
    or (status in ('consumed', 'released') and quantity >= 0)
  );

notify pgrst, 'reload schema';
