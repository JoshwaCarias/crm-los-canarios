-- Rol adicional para el personal de Bodega.
-- Ejecutar después de 018_inventory_allocation_zero_fix.sql y antes de
-- 019_raw_materials_production_workflow.sql. Se mantiene separado porque
-- PostgreSQL exige confirmar un nuevo valor de enum antes de usarlo.

alter type public.app_role add value if not exists 'warehouse';

notify pgrst, 'reload schema';
