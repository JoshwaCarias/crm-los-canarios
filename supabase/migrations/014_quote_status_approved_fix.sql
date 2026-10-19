-- Corrección para instalaciones que ejecutaron 007 sin el estado approved.
-- Ejecutar este archivo por separado en Supabase SQL Editor.

alter type public.quote_status add value if not exists 'approved' after 'pending_admin_approval';

notify pgrst, 'reload schema';
