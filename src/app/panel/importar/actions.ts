"use server";

import readXlsxFile from "read-excel-file/node";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { hasAnyRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

type Cell = string | number | Date | boolean | null;
type Row = Cell[];
type WorkbookSheet = { sheet: string; data: Row[] };

function failure(message: string): never { redirect(`/panel/importar?error=${encodeURIComponent(message)}`); }
function normalized(value: Cell | undefined) { return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase(); }
function value(row: Row, columns: Map<string, number>, header: string) { const index = columns.get(header); return index === undefined ? "" : String(row[index] ?? "").trim(); }
function decimal(row: Row, columns: Map<string, number>, header: string, fallback: number | null = null) { const raw = value(row, columns, header).replace(/,/g, ""); if (!raw) return fallback; const parsed = Number(raw); return Number.isFinite(parsed) ? parsed : Number.NaN; }
function dateValue(row: Row, columns: Map<string, number>, header: string) { const index = columns.get(header); const raw = index === undefined ? null : row[index]; if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString().slice(0, 10); const text = String(raw ?? "").trim(); return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ""; }
function records(rows: Row[], required: string[]) {
  if (rows.length < 2) return [] as { row: Row; columns: Map<string, number>; line: number }[];
  const columns = new Map(rows[0].map((heading, index) => [normalized(heading), index]));
  const absent = required.filter((heading) => !columns.has(heading));
  if (absent.length) throw new Error(`La hoja requiere las columnas: ${absent.join(", ")}.`);
  return rows.slice(1).map((row, index) => ({ row, columns, line: index + 2 })).filter(({ row }) => row.some((cell) => String(cell ?? "").trim()));
}

function sheetRows(workbook: WorkbookSheet[], sheetName: string) {
  const sheet = workbook.find((entry) => entry.sheet === sheetName);
  if (!sheet) throw new Error(`No se encontró la hoja ${sheetName}.`);
  return sheet.data;
}

export async function importWorkbook(formData: FormData) {
  const user = await getCurrentUser();
  if (!hasAnyRole(user.roles, ["admin"])) failure("Sólo Administración puede importar información.");
  const upload = formData.get("workbook");
  if (!(upload instanceof File) || upload.size === 0) failure("Selecciona un archivo Excel válido.");
  if (upload.size > 5 * 1024 * 1024) failure("El archivo supera el límite de 5 MB.");
  if (!/\.xlsx$/i.test(upload.name)) failure("Usa un archivo con extensión .xlsx.");

  let workbook: WorkbookSheet[]; let file: Buffer;
  try {
    file = Buffer.from(await upload.arrayBuffer());
    workbook = await readXlsxFile(file) as unknown as WorkbookSheet[];
  } catch { failure("No fue posible leer el archivo Excel."); }
  const sheets = workbook.map((sheet) => sheet.sheet);
  const supported = ["Clientes", "Productos", "Precios", "Saldos iniciales"];
  if (!sheets.some((sheet) => supported.includes(sheet))) failure("El archivo no contiene hojas compatibles. Descarga y usa la plantilla del CRM.");
  const supabase = await createClient();
  const counts = { customers: 0, products: 0, prices: 0, balances: 0 };

  try {
    if (sheets.includes("Clientes")) {
      const rows = sheetRows(workbook, "Clientes");
      const entries = records(rows, ["razon social", "nit"]);
      if (entries.length > 1000) throw new Error("La hoja Clientes supera el límite de 1,000 filas.");
      const seen = new Set<string>();
      const payload = entries.map(({ row, columns, line }) => {
        const legalName = value(row, columns, "razon social"); const nit = value(row, columns, "nit");
        const creditLimit = decimal(row, columns, "limite de credito", 0) ?? 0; const creditUsed = decimal(row, columns, "credito usado", 0) ?? 0; const creditDays = decimal(row, columns, "dias de credito", 0) ?? 0;
        if (!legalName || !nit || seen.has(nit)) throw new Error(`Clientes, fila ${line}: razón social o NIT inválido/repetido.`);
        if (!Number.isFinite(creditLimit) || !Number.isFinite(creditUsed) || !Number.isInteger(creditDays) || creditLimit < 0 || creditUsed < 0 || creditUsed > creditLimit || creditDays < 0) throw new Error(`Clientes, fila ${line}: revisa los campos de crédito.`);
        seen.add(nit);
        return { legal_name: legalName, trade_name: value(row, columns, "nombre comercial") || null, nit, phone: value(row, columns, "telefono") || null, email: value(row, columns, "correo") || null, credit_limit: creditLimit, credit_used: creditUsed, credit_days: creditDays, created_by: user.id };
      });
      if (payload.length) { const { error } = await supabase.from("customers").upsert(payload, { onConflict: "nit" }); if (error) throw error; counts.customers = payload.length; }
    }
    if (sheets.includes("Productos")) {
      const rows = sheetRows(workbook, "Productos");
      const entries = records(rows, ["sku", "nombre"]); if (entries.length > 1000) throw new Error("La hoja Productos supera el límite de 1,000 filas.");
      const seen = new Set<string>();
      const payload = entries.map(({ row, columns, line }) => {
        const sku = value(row, columns, "sku").toUpperCase(); const name = value(row, columns, "nombre"); const diameter = decimal(row, columns, "diametro mm"); const length = decimal(row, columns, "longitud mm"); const weight = decimal(row, columns, "peso kg");
        if (!sku || !name || seen.has(sku)) throw new Error(`Productos, fila ${line}: SKU o nombre inválido/repetido.`);
        if ([diameter, length, weight].some((amount) => amount !== null && (!Number.isFinite(amount) || amount < 0))) throw new Error(`Productos, fila ${line}: revisa las medidas.`);
        seen.add(sku);
        return { sku, name, description: value(row, columns, "descripcion") || null, diameter_mm: diameter, length_mm: length, strength_class: value(row, columns, "clase") || null, joint_type: value(row, columns, "union") || null, unit: value(row, columns, "unidad") || "unidad", weight_kg: weight };
      });
      if (payload.length) { const { error } = await supabase.from("products").upsert(payload, { onConflict: "sku" }); if (error) throw error; counts.products = payload.length; }
    }
    if (sheets.includes("Precios")) {
      const rows = sheetRows(workbook, "Precios");
      const entries = records(rows, ["lista de precios", "fecha inicio", "sku", "precio unitario"]); if (entries.length > 3000) throw new Error("La hoja Precios supera el límite de 3,000 filas.");
      const allProductsResult = await supabase.from("products").select("id, sku").eq("is_active", true); const productBySku = new Map((allProductsResult.data ?? []).map((product) => [product.sku, product.id]));
      const lists = new Map<string, { valid_from: string; valid_to: string | null }>(); const priceKeys = new Set<string>(); const entriesParsed = entries.map(({ row, columns, line }) => {
        const list = value(row, columns, "lista de precios"); const validFrom = dateValue(row, columns, "fecha inicio"); const validTo = dateValue(row, columns, "fecha fin") || null; const sku = value(row, columns, "sku").toUpperCase(); const price = decimal(row, columns, "precio unitario");
        if (!list || !validFrom || !sku || price === null || !Number.isFinite(price) || price < 0 || !productBySku.has(sku)) throw new Error(`Precios, fila ${line}: lista, fechas, SKU o precio inválidos.`);
        if (validTo && validTo < validFrom) throw new Error(`Precios, fila ${line}: fecha final inválida.`);
        const priceKey = `${list.toLocaleLowerCase()}::${sku}`; if (priceKeys.has(priceKey)) throw new Error(`Precios, fila ${line}: el SKU ${sku} está repetido dentro de la lista ${list}.`); priceKeys.add(priceKey);
        const existing = lists.get(list); if (existing && (existing.valid_from !== validFrom || existing.valid_to !== validTo)) throw new Error(`Precios, fila ${line}: la lista ${list} tiene fechas distintas.`);
        lists.set(list, { valid_from: validFrom, valid_to: validTo }); return { list, sku, price };
      });
      const priceListIds = new Map<string, string>();
      for (const [name, dates] of lists) { const { data, error } = await supabase.from("price_lists").upsert({ name, valid_from: dates.valid_from, valid_to: dates.valid_to, is_active: true }, { onConflict: "name" }).select("id").single(); if (error || !data) throw error ?? new Error("No fue posible crear la lista de precios."); priceListIds.set(name, data.id); }
      const pricePayload = entriesParsed.map((entry) => ({ price_list_id: priceListIds.get(entry.list)!, product_id: productBySku.get(entry.sku)!, unit_price: entry.price }));
      if (pricePayload.length) { const { error } = await supabase.from("price_list_items").upsert(pricePayload, { onConflict: "price_list_id,product_id" }); if (error) throw error; counts.prices = pricePayload.length; }
    }
    if (sheets.includes("Saldos iniciales")) {
      const rows = sheetRows(workbook, "Saldos iniciales");
      const entries = records(rows, ["nit", "credito usado"]); if (entries.length > 1000) throw new Error("La hoja Saldos iniciales supera el límite de 1,000 filas.");
      const nits = entries.map(({ row, columns }) => value(row, columns, "nit")); const customerByNit = new Map((await supabase.from("customers").select("id, nit, credit_limit").in("nit", nits)).data?.map((customer) => [customer.nit, customer]) ?? []); const seen = new Set<string>();
      for (const { row, columns, line } of entries) { const nit = value(row, columns, "nit"); const creditUsed = decimal(row, columns, "credito usado"); const customer = customerByNit.get(nit); if (!nit || seen.has(nit) || !customer || creditUsed === null || !Number.isFinite(creditUsed) || creditUsed < 0 || creditUsed > Number(customer.credit_limit)) throw new Error(`Saldos iniciales, fila ${line}: NIT o saldo inválido/repetido.`); seen.add(nit); const { error } = await supabase.from("customers").update({ credit_used: creditUsed, updated_at: new Date().toISOString() }).eq("id", customer.id); if (error) throw error; counts.balances += 1; }
    }
  } catch (error) {
    failure(error instanceof Error ? error.message : "No fue posible importar el archivo.");
  }

  revalidatePath("/panel/clientes"); revalidatePath("/panel/productos"); revalidatePath("/panel/finanzas"); revalidatePath("/panel/cotizaciones/nueva");
  redirect(`/panel/importar?notice=${encodeURIComponent(`Importación terminada: ${counts.customers} clientes, ${counts.products} productos, ${counts.prices} precios y ${counts.balances} saldos.`)}`);
}
