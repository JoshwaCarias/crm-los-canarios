# CRM Los Canarios

Primera aplicación Next.js del CRM: autenticación mediante Supabase, panel protegido y contenido adaptado a los roles de operación.

## Antes de iniciar

1. En una base nueva de Supabase, ejecuta primero `supabase/migrations/001_crm_schema.sql`. No vuelvas a ejecutar el esquema inicial sobre una base existente sin revisar previamente su estado y contar con un respaldo.
2. Ejecuta las migraciones en este orden dentro de **Supabase → SQL Editor**: `002_security.sql`, `003_customer_history_discount_location.sql`, `004_quotes_sales_ownership_followups.sql`, `005_quote_read_policy.sql` y `006_quote_detail_rpc.sql`. Para el flujo operativo ejecuta después `007_quote_workflow_statuses.sql` y, en una nueva ejecución del SQL Editor, `008_quote_workflow.sql`. Después ejecuta, en orden, `009_quote_freight.sql` a `018_inventory_allocation_zero_fix.sql`, luego `018b_warehouse_role.sql`, `019_raw_materials_production_workflow.sql` y `020_fix_production_requirement_loop.sql`. Esta separación es necesaria para confirmar los nuevos estados de PostgreSQL antes de utilizarlos.
3. Copia `.env.local.example` como `.env.local` y completa la URL y la **Publishable key** de Supabase. Para habilitar la creación de cuentas desde Administración, agrega también `SUPABASE_SERVICE_ROLE_KEY` sólo en `.env.local` y en las variables privadas de Vercel; nunca la pongas en código, en variables `NEXT_PUBLIC_` ni en Git.
4. Instala dependencias y arranca el entorno local:

   ```powershell
   npm install
   npm run dev
   ```

5. Abre `http://localhost:3000`, inicia sesión con el usuario creado en Supabase Auth y usa un perfil/rol asignado en las tablas `profiles` y `user_roles`.

## Despliegue en Vercel

1. Sube esta carpeta a un repositorio Git privado.
2. Importa el repositorio en Vercel.
3. En **Settings → Environment Variables**, registra `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` y la variable privada `SUPABASE_SERVICE_ROLE_KEY` para Production, Preview y Development. Esta última sólo se usa en acciones de servidor para administrar usuarios.
4. Despliega. En Supabase Auth → URL Configuration, agrega la URL final de Vercel y `http://localhost:3000` como redirecciones permitidas.

## Alcance de esta primera interfaz

- Login y cierre de sesión.
- Validación de sesión desde el servidor.
- Renovación segura de sesión mediante `src/proxy.ts`.
- Lectura del perfil y roles desde Supabase.
- Panel adaptado a vendedor, despacho, planta, contabilidad, administración y gerencia.
- Contadores iniciales de documentos operativos permitidos para el rol.
- Clientes: búsqueda, alta, ficha, contactos y obras/direcciones de entrega.
- Ficha de cliente: tarjetas de pedidos/cotizaciones, historial con vendedor, descuento autorizado y mapa de ubicación.
- Productos: consulta del catálogo para todos los roles y alta restringida a Administración/Gerencia.
- Cotizaciones: correlativo, cliente, dirección, condiciones de pago/entrega, productos, disponibilidad libre en bodega, faltantes por fabricar, flete estimado e impresión/guardado como PDF.
- Flujo de cotizaciones: aprobación administrativa, fabricación, autorización de despacho, despacho, ruta, entrega, cancelación con motivo y bitácora por responsable.
- Pedidos automáticos desde cotizaciones aprobadas, con reserva de crédito sobre el total incluido el flete.
- Producción e inventario: materia prima, compras de Bodega, fórmulas por tubo, necesidades de fabricación, lotes frescos, curado, liberación de producto terminado, reservas por pedido y reasignación controlada.
- Despachos: entregas parciales, varios fletes por día, selección de cantidades reservadas, vehículo, piloto, costo real, carga, salida a ruta y entrega.
- Finanzas: una factura por entrega parcial diaria, que incluye todos sus fletes confirmados, cobros, liberación de crédito, historial y detalle imprimible de cada factura.
- Reportes gerenciales: ventas del mes, embudo de cotizaciones, desempeño por vendedor, productos principales, cuentas por cobrar y margen de flete.
- Alertas operativas: vencimientos, seguimientos, crédito cercano al límite, pedidos atrasados, despachos y cobros.
- Gestión comercial: vendedor responsable, última cotización y bitácora de llamadas, WhatsApp, correos o visitas.
- Control comercial: metas mensuales por vendedor, avance de ventas y cotizaciones, embudo de estados y seguimientos por atender.
- Importación inicial desde Excel: clientes, productos, listas de precios y saldos de crédito, con validación antes de insertar.
- Administración: creación, edición y eliminación permanente de usuarios de Supabase Auth, activación/desactivación y asignación de uno o varios roles. Admite Gmail, correos corporativos y cualquier dominio válido.
- Navegación por rol: cada persona ve sólo los módulos correspondientes a sus roles; un vendedor ve Clientes, Productos, Cotizaciones, Pedidos, Control comercial y Mi perfil. El rol Bodega consulta producción y registra ingresos de materia prima, sin poder alterar fórmulas ni liberar tubos.
- Mi perfil: teléfono y sede del vendedor, que se muestran automáticamente en cada cotización.

## Prueba de Clientes y Productos

1. Ingresa como usuario con rol `seller`, `admin` o `manager`.
2. Abre **Clientes** y crea un cliente con razón social y NIT. Un vendedor crea el cliente sin crédito; Administración o Gerencia puede definirlo.
3. En la ficha del cliente, agrega un contacto y una obra/dirección de entrega. Busca la dirección en Google Maps si lo necesitas y luego haz clic o arrastra el pin dentro del mapa del CRM; se guardarán las coordenadas y un enlace compartible.
4. Como `admin`, cambia el descuento autorizado del cliente. Todo cliente inicia en 5%; ese valor queda disponible automáticamente para las futuras cotizaciones del cliente.
5. Ingresa como `admin` o `manager`, abre **Productos** y registra un tubo con su SKU, diámetro, longitud, clase y tipo de unión.
6. Ingresa como `seller`: podrás consultar Productos, pero no verás la acción para crear productos ni para cambiar descuentos.

## Prueba de Cotizaciones y Seguimiento

1. Como administrador, abre la ficha de cada cliente existente y asigna su vendedor responsable.
2. Cada vendedor debe completar **Mi perfil** con teléfono y dirección/sede; estos datos aparecerán al pie de sus cotizaciones.
3. En **Cotizaciones → Nueva cotización**, selecciona un cliente, condiciones de pago, dirección de entrega, uno o más productos y el valor de flete. El sistema limita el descuento de cada línea al porcentaje autorizado del cliente; el flete se suma completo al total sin descuento.
4. Al emitirla, se genera el correlativo, queda registrada como emitida y se abre una versión imprimible similar al formato actual. Usa **Imprimir / Guardar PDF** desde el navegador.
5. En la ficha de cliente, registra un seguimiento después de una llamada, mensaje, correo o visita. Administración puede revisar el último seguimiento y la última cotización.

## Prueba del flujo de cotizaciones

1. Un vendedor crea una cotización. Nace como **Pendiente de aprobación administrativa**.
2. Un usuario con rol `admin` o `manager` la abre y usa **Aprobar para fabricación**.
3. Planta, Administración o Gerencia la mueve a **En fabricación** y después a **Pendiente de autorización de despacho**.
4. Despacho, Administración o Gerencia usa **Autorizar y pasar a despacho**, después **Marcar salida a ruta** y finalmente **Confirmar entrega**.
5. La bitácora conserva cada cambio de estado, el responsable, fecha y las observaciones. La cancelación exige un motivo.
6. El vendedor responsable o Administración puede modificar la cotización sólo antes de que entre a Despacho. Al modificarla, el precio se recalcula y regresa a aprobación administrativa.

## Prueba de pedidos, despacho, producción y finanzas

1. Aprueba una cotización. Se crea un **Pedido marco** automáticamente. La cotización muestra disponibilidad, pero la reserva real se realiza sólo al aprobarla. Si se seleccionó Crédito, se reserva el total estimado contra el cupo.
2. En **Producción e inventario**, Administración crea al menos una ubicación y Planta registra lotes. La cantidad aceptada genera inventario y se reserva para los pedidos en orden de creación. Administración o Logística puede reasignar una reserva de forma manual cuando exista una urgencia.
3. Desde el flujo de la cotización, pasa el pedido hasta **En despacho**. En **Despachos**, selecciona las cantidades de cada producto para un flete parcial. Los camiones del mismo pedido y fecha se agrupan en una entrega diaria.
4. Confirma todos los fletes de esa entrega. En **Finanzas** aparecerá una sola entrega por facturar, con los productos realmente entregados y una línea de flete por cada camión.
5. Al generar una factura, el CRM abre su detalle con los productos, fletes, total y saldo. También puedes abrirla después desde **Historial de facturas** en Finanzas; las facturas pagadas permanecen ahí.
6. Registra pagos en Finanzas. Cada cobro actualiza saldo de factura y libera el crédito reservado del cliente.

## Prueba de materia prima y fabricación

1. Ejecuta primero `018b_warehouse_role.sql`, luego `019_raw_materials_production_workflow.sql` y `020_fix_production_requirement_loop.sql`. Como Administrador, crea o asigna el rol **Bodega** a quien recibe compras; también puedes conservar Planta para esta función.
2. En **Producción e inventario**, crea las ubicaciones necesarias —por ejemplo `BODEGA-01` y `PLANTA-01`—, da de alta Cemento, Hierro, Arena y los demás materiales, y registra una fórmula por cada tipo de tubo.
3. Bodega registra cada compra indicando el material, ubicación, cantidad, proveedor y referencia. El tablero muestra el total por ubicación y resalta los materiales por debajo de su mínimo.
4. Planta inicia un lote seleccionando de qué ubicación tomará la materia prima y dónde quedará el producto terminado. El sistema valida y descuenta los componentes, pero los tubos quedan como **Frescos**.
5. Planta pulsa **Iniciar curado** cuando corresponde. Al terminar las horas definidas, usa **Verificar y liberar**. Sólo entonces el lote entra al inventario vendible y puede reservarse para un pedido o despacharse.

## Reportes y alertas

1. Como `admin` o `manager`, abre **Reportes** para consultar los indicadores mensuales y los rankings de ventas.
2. Abre **Alertas** para revisar cotizaciones por vencer, seguimientos pendientes, crédito consumido, pedidos detenidos, despachos de hoy y facturas vencidas.
3. Cada alerta enlaza al módulo o documento desde el que se puede atender.

## Control comercial, importación y usuarios

1. Ejecuta `011_commercial_targets.sql`. Como `admin` o `manager`, abre **Control comercial** y asigna a cada vendedor una meta de ventas y de cotizaciones para el mes. Los vendedores sólo ven su propio avance y sus seguimientos; Gerencia y Administración ven el conjunto.
2. En **Importar Excel**, descarga la plantilla. Conserva los nombres de las cuatro hojas y sus encabezados. Puedes completar sólo las hojas que necesites: Clientes, Productos, Precios y Saldos iniciales.
3. Carga primero una copia pequeña del archivo. El CRM rechaza encabezados alterados, NIT o SKU duplicados, importes inválidos, saldos superiores al límite de crédito, productos inexistentes en precios y fechas incoherentes. Clientes se actualizan por NIT y productos por SKU.
4. Para cargar precios, importa los productos antes (en la misma plantilla o en una carga previa). Cada lista de precios debe llevar las mismas fechas de inicio y fin en todas sus filas.
5. Para crear usuarios, configura `SUPABASE_SERVICE_ROLE_KEY` como variable privada del servidor y reinicia el entorno local o vuelve a desplegar en Vercel. Después, como `admin`, abre **Administración**, define una contraseña temporal de al menos 12 caracteres y selecciona uno o más roles. Se aceptan correos corporativos o personales de cualquier dominio válido.
6. En el mismo módulo puedes modificar nombre, correo, contraseña, estado y roles. Para borrar una cuenta de forma permanente escribe `ELIMINAR` en su confirmación. El sistema impide que borres tu propia cuenta o te quites el rol de Administrador.

## Mapas y token de Mapbox

La implementación actual usa OpenStreetMap para mostrar y seleccionar el pin, y genera enlaces de Google Maps para búsqueda y uso compartido. Por ello no se incluyó el token de Mapbox que compartiste: no está en el código, archivos de entorno ni repositorio. Si más adelante se integra búsqueda geográfica de Mapbox, el token debe permanecer sólo en `.env.local`/variables de Vercel y restringirse por dominio en Mapbox.

Las operaciones sensibles —flujo de documentos, importación y administración de usuarios— se ejecutan en el servidor o mediante funciones PostgreSQL, no mediante actualizaciones directas desde el navegador.
