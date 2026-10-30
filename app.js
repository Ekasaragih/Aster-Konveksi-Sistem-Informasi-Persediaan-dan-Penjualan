const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const STORAGE_MODE = process.env.STORAGE_MODE || 'supabase';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const LOCAL_DATA_DIRECTORY = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Stockita');
const LOCAL_DATABASE_PATH = path.join(LOCAL_DATA_DIRECTORY, 'stockita-data.json');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

class ApiError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function requireSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new ApiError('Backend Supabase belum dikonfigurasi. Atur SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY di environment server.', 503);
  }
}

async function supabase(pathname, options = {}) {
  requireSupabase();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const message = body?.message || body?.hint || body?.details || (typeof body === 'string' ? body : 'Permintaan Supabase gagal.');
    throw new ApiError(message, response.status);
  }
  return body;
}

  function readLocalDatabase() {
    if (!fs.existsSync(LOCAL_DATABASE_PATH)) {
      return { products: [], sales: [], payments: [], items: [], movements: [], productionOrders: [], productionInputs: [], financialEntries: [], next: { product: 0, sale: 0, payment: 0, item: 0, movement: 0, production: 0, input: 0, financial: 0 } };
    }
    try {
      const database = JSON.parse(fs.readFileSync(LOCAL_DATABASE_PATH, 'utf8'));
      if (!database || !Array.isArray(database.products) || !Array.isArray(database.sales)) throw new Error('Struktur penyimpanan lokal tidak valid.');
      return database;
    } catch (error) {
      throw new ApiError(`Data lokal tidak dapat dibaca: ${error.message}`, 500);
    }
  }

  function writeLocalDatabase(database) {
    const temporaryPath = `${LOCAL_DATABASE_PATH}.tmp`;
    try {
      fs.mkdirSync(LOCAL_DATA_DIRECTORY, { recursive: true });
      fs.writeFileSync(temporaryPath, JSON.stringify(database, null, 2), 'utf8');
      fs.renameSync(temporaryPath, LOCAL_DATABASE_PATH);
    } catch (error) {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      throw new ApiError(`Data lokal gagal disimpan: ${error.message}`, 500);
    }
  }

  function localId(database, type) {
    database.next[type] = (database.next[type] || 0) + 1;
    return database.next[type];
  }

  function localProductStatus(product) {
    return { ...product, is_low_stock: Number(product.stock) <= Number(product.min_stock) ? 1 : 0 };
  }

  function localSaleSummary(database, sale) {
    const payments = database.payments.filter((payment) => Number(payment.sale_id) === Number(sale.id));
    const paid = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
    return {
      ...sale,
      paid,
      remaining: sale.voided_at ? 0 : Math.max(0, Number(sale.total) - paid),
      status: sale.voided_at ? 'Dibatalkan' : paid >= Number(sale.total) ? 'Lunas' : paid > 0 ? 'DP' : 'Belum bayar',
      item_count: database.items.filter((item) => Number(item.sale_id) === Number(sale.id)).length,
    };
  }

  function localBaseData(database) {
    return {
      products: database.products.filter((product) => !product.archived_at),
      sales: database.sales.filter((sale) => !sale.voided_at),
      payments: database.payments,
      items: database.items,
      financialEntries: database.financialEntries,
    };
  }

  function localOverview(database) {
    const data = localBaseData(database);
    return buildOverview(data);
  }

  function localReports(database) {
    return buildReports(localBaseData(database));
  }

  function handleLocalApi(req, res, url) {
    const route = url.pathname;
    const method = req.method;
    const database = readLocalDatabase();
    const now = new Date().toISOString();
    if (method === 'GET' && route === '/api/health') {
      return sendJson(res, 200, { ok: true, status: 'success', database: 'local' });
    }
    if (method === 'GET' && route === '/api/overview') return sendJson(res, 200, localOverview(database));
    if (method === 'GET' && route === '/api/products') {
      return sendJson(res, 200, database.products.filter((product) => !product.archived_at).map(localProductStatus).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)));
    }
    if (method === 'GET' && route === '/api/sales') {
      return sendJson(res, 200, database.sales.map((sale) => localSaleSummary(database, sale)).sort((a, b) => b.sold_at.localeCompare(a.sold_at)).slice(0, 100));
    }
    if (method === 'GET' && route === '/api/reports') return sendJson(res, 200, localReports(database));
    if (method === 'GET' && route === '/api/production') {
      return sendJson(res, 200, database.productionOrders.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100).map((order) => ({
        ...order,
        production_inputs: database.productionInputs.filter((input) => Number(input.production_id) === Number(order.id)),
      })));
    }
    if (method === 'GET' && route === '/api/financial-entries') {
      return sendJson(res, 200, database.financialEntries.slice().sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.id - a.id).slice(0, 200));
    }
    const detailMatch = route.match(/^\/api\/sales\/(\d+)$/);
    if (method === 'GET' && detailMatch) {
      const sale = database.sales.find((entry) => Number(entry.id) === Number(detailMatch[1]));
      if (!sale) throw new ApiError('Transaksi tidak ditemukan.', 404);
      return sendJson(res, 200, {
        ...localSaleSummary(database, sale),
        items: database.items.filter((item) => Number(item.sale_id) === Number(sale.id)),
        payments: database.payments.filter((payment) => Number(payment.sale_id) === Number(sale.id)),
      });
    }
    if (method === 'POST' && route === '/api/products') {
      return readJson(req).then((data) => {
        const name = String(data.name || '').trim();
        if (!name || !['material', 'finished'].includes(data.kind)) throw new ApiError('Nama barang dan jenis persediaan wajib diisi.', 400);
        const sku = String(data.sku || `AST-${Date.now().toString().slice(-7)}`).trim();
        if (database.products.some((item) => item.sku.toLowerCase() === sku.toLowerCase())) throw new ApiError('Kode SKU sudah digunakan.', 409);
        const barcode = String(data.barcode || '').trim();
        if (barcode && database.products.some((item) => item.barcode === barcode)) throw new ApiError('Barcode sudah digunakan.', 409);
        const product = {
          id: localId(database, 'product'), sku, barcode, name,
          category: String(data.category || 'Lainnya').trim(), kind: data.kind, unit: String(data.unit || 'pcs').trim(),
          stock: number(data.stock ?? 0, 'Stok'), min_stock: number(data.min_stock ?? 0, 'Batas minimum'),
          cost_price: number(data.cost_price ?? 0, 'HPP per unit'), sale_price: number(data.sale_price ?? 0, 'Harga jual'),
          created_at: now,
        };
        database.products.push(product);
        if (product.stock > 0) database.movements.push({ id: localId(database, 'movement'), product_id: product.id, movement_type: 'initial', quantity_delta: product.stock, unit_cost: product.cost_price, note: 'Saldo awal', created_at: now });
        writeLocalDatabase(database);
        return sendJson(res, 201, localProductStatus(product));
      });
    }
    const archiveProductMatch = route.match(/^\/api\/products\/(\d+)$/);
    if (method === 'DELETE' && archiveProductMatch) {
      return readJson(req).then((data) => {
        const product = database.products.find((item) => Number(item.id) === Number(archiveProductMatch[1]) && !item.archived_at);
        const reason = String(data.reason || '').trim();
        if (!product) throw new ApiError('Barang tidak ditemukan atau sudah dihapus.', 404);
        if (!reason) throw new ApiError('Alasan penghapusan wajib diisi.', 400);
        product.archived_at = now;
        product.archive_reason = reason;
        writeLocalDatabase(database);
        return sendJson(res, 200, { ok: true, product_id: product.id, archived_at: now, reason });
      });
    }
    if (method === 'POST' && route === '/api/stock-adjustments') {
      return readJson(req).then((data) => {
        const product = database.products.find((item) => Number(item.id) === Number(data.product_id));
        if (!product) throw new ApiError('Barang tidak ditemukan.', 404);
        const delta = Number(data.quantity_delta);
        if (!Number.isFinite(delta) || delta === 0 || Number(product.stock) + delta < 0) throw new ApiError('Jumlah perubahan tidak valid atau stok tidak mencukupi.', 400);
        product.stock = Number(product.stock) + delta;
        database.movements.push({ id: localId(database, 'movement'), product_id: product.id, movement_type: 'adjustment', quantity_delta: delta, unit_cost: product.cost_price, note: String(data.note || 'Penyesuaian stok').trim(), created_at: now });
        writeLocalDatabase(database);
        return sendJson(res, 200, localProductStatus(product));
      });
    }
    if (method === 'POST' && route === '/api/sales') {
      return readJson(req).then((data) => {
        const customer = String(data.customer || '').trim();
        if (!customer || !Array.isArray(data.items) || data.items.length === 0) throw new ApiError('Nama pelanggan dan minimal satu barang wajib diisi.', 400);
        const prepared = data.items.map((line) => {
          const product = database.products.find((item) => Number(item.id) === Number(line.product_id) && !item.archived_at);
          if (!product) throw new ApiError('Barang tidak ditemukan.', 404);
          return {
            product, quantity: number(line.quantity, 'Kuantitas', { min: 0, allowZero: false }),
            unit_price: number(line.unit_price ?? product.sale_price, 'Harga jual'),
          };
        });
        const requested = new Map();
        for (const line of prepared) requested.set(line.product.id, (requested.get(line.product.id) || 0) + line.quantity);
        for (const [productId, amount] of requested) {
          const product = database.products.find((item) => Number(item.id) === Number(productId));
          if (amount > Number(product.stock)) throw new ApiError(`Stok ${product.name} tidak mencukupi.`, 400);
        }
        const total = prepared.reduce((sum, line) => sum + line.quantity * line.unit_price, 0);
        const cogs = prepared.reduce((sum, line) => sum + line.quantity * Number(line.product.cost_price), 0);
        const initialPayment = number(data.initial_payment ?? 0, 'Pembayaran awal');
        if (initialPayment > total) throw new ApiError('Pembayaran awal melebihi total transaksi.', 400);
        const id = localId(database, 'sale');
        const invoice = `AST-${now.slice(0, 10).replaceAll('-', '')}-${String(id).padStart(5, '0')}`;
        const sale = { id, invoice, customer, note: String(data.note || '').trim(), sold_at: now, total, cogs, voided_at: null, void_reason: null };
        database.sales.push(sale);
        for (const line of prepared) {
          const lineCogs = line.quantity * Number(line.product.cost_price);
          database.items.push({ id: localId(database, 'item'), sale_id: id, product_id: line.product.id, product_name: line.product.name, quantity: line.quantity, unit_price: line.unit_price, unit_cost: line.product.cost_price, subtotal: line.quantity * line.unit_price, line_cogs: lineCogs });
          line.product.stock = Number(line.product.stock) - line.quantity;
          database.movements.push({ id: localId(database, 'movement'), product_id: line.product.id, movement_type: 'sale', quantity_delta: -line.quantity, unit_cost: line.product.cost_price, note: `Penjualan ${invoice}`, created_at: now });
        }
        if (initialPayment > 0) database.payments.push({ id: localId(database, 'payment'), sale_id: id, amount: initialPayment, method: String(data.payment_method || 'Transfer'), paid_at: now });
        writeLocalDatabase(database);
        return sendJson(res, 201, sale);
      });
    }
    const paymentMatch = route.match(/^\/api\/sales\/(\d+)\/payments$/);
    if (method === 'POST' && paymentMatch) {
      return readJson(req).then((data) => {
        const sale = database.sales.find((entry) => Number(entry.id) === Number(paymentMatch[1]) && !entry.voided_at);
        if (!sale) throw new ApiError('Transaksi tidak ditemukan atau telah dibatalkan.', 404);
        const amount = number(data.amount, 'Nominal pembayaran', { min: 0, allowZero: false });
        const paid = database.payments.filter((entry) => Number(entry.sale_id) === Number(sale.id)).reduce((sum, entry) => sum + Number(entry.amount), 0);
        if (amount > Number(sale.total) - paid) throw new ApiError('Nominal pembayaran melebihi sisa tagihan.', 400);
        database.payments.push({ id: localId(database, 'payment'), sale_id: sale.id, amount, method: String(data.method || 'Transfer'), paid_at: now });
        writeLocalDatabase(database);
        return sendJson(res, 201, { ok: true, remaining: Number(sale.total) - paid - amount });
      });
    }
    if (method === 'POST' && route === '/api/production') {
      return readJson(req).then((data) => {
        const output = database.products.find((item) => Number(item.id) === Number(data.output_product_id) && item.kind === 'finished' && !item.archived_at);
        const outputQuantity = number(data.output_quantity, 'Jumlah produksi', { min: 0, allowZero: false });
        const labor = number(data.labor_cost ?? 0, 'Biaya tenaga kerja');
        const overhead = number(data.overhead_cost ?? 0, 'Biaya overhead');
        if (!output) throw new ApiError('Produk barang jadi tidak ditemukan.', 404);
        if (!Array.isArray(data.inputs) || !data.inputs.length) throw new ApiError('Minimal satu bahan baku harus dipilih.', 400);
        const requestedMaterials = new Map();
        for (const line of data.inputs) {
          const productId = Number(line.product_id);
          const quantity = number(line.quantity, 'Jumlah bahan', { min: 0, allowZero: false });
          requestedMaterials.set(productId, (requestedMaterials.get(productId) || 0) + quantity);
        }
        const inputs = [...requestedMaterials].map(([productId, quantity]) => {
          const product = database.products.find((item) => Number(item.id) === productId && item.kind === 'material' && !item.archived_at);
          if (!product || quantity > Number(product.stock)) throw new ApiError('Bahan baku tidak ditemukan atau stok tidak mencukupi.', 400);
          return { product, quantity };
        });
        const materialCost = inputs.reduce((sum, line) => sum + line.quantity * Number(line.product.cost_price), 0);
        const totalCost = materialCost + labor + overhead;
        const unitCost = Math.round(totalCost / outputQuantity * 100) / 100;
        const id = localId(database, 'production');
        database.productionOrders.push({ id, output_product_id: output.id, output_product_name: output.name, output_quantity: outputQuantity, material_cost: materialCost, labor_cost: labor, overhead_cost: overhead, total_cost: totalCost, unit_cost: unitCost, note: String(data.note || ''), created_at: now });
        for (const line of inputs) {
          line.product.stock = Number(line.product.stock) - line.quantity;
          database.productionInputs.push({ id: localId(database, 'input'), production_id: id, product_id: line.product.id, product_name: line.product.name, quantity: line.quantity, unit_cost: line.product.cost_price, line_cost: line.quantity * Number(line.product.cost_price) });
          database.movements.push({ id: localId(database, 'movement'), product_id: line.product.id, movement_type: 'production_input', quantity_delta: -line.quantity, unit_cost: line.product.cost_price, note: `Produksi #${id}`, created_at: now });
        }
        output.stock = Number(output.stock) + outputQuantity;
        output.cost_price = unitCost;
        database.movements.push({ id: localId(database, 'movement'), product_id: output.id, movement_type: 'production_output', quantity_delta: outputQuantity, unit_cost: unitCost, note: `Hasil produksi #${id}`, created_at: now });
        writeLocalDatabase(database);
        return sendJson(res, 201, { id, output_product_id: output.id, output_quantity: outputQuantity, material_cost: materialCost, labor_cost: labor, overhead_cost: overhead, total_cost: totalCost, unit_cost: unitCost, created_at: now });
      });
    }
    const voidMatch = route.match(/^\/api\/sales\/(\d+)\/void$/);
    if (method === 'POST' && voidMatch) {
      return readJson(req).then((data) => {
        const sale = database.sales.find((entry) => Number(entry.id) === Number(voidMatch[1]));
        const reason = String(data.reason || '').trim();
        if (!sale || sale.voided_at) throw new ApiError('Transaksi tidak ditemukan atau sudah dibatalkan.', 404);
        if (!reason) throw new ApiError('Alasan pembatalan wajib diisi.', 400);
        for (const item of database.items.filter((entry) => Number(entry.sale_id) === Number(sale.id))) {
          const product = database.products.find((entry) => Number(entry.id) === Number(item.product_id));
          if (!product) throw new ApiError(`Barang ${item.product_name} sudah tidak tersedia; stok tidak dapat dikembalikan.`, 409);
          product.stock = Number(product.stock) + Number(item.quantity);
          database.movements.push({ id: localId(database, 'movement'), product_id: product.id, movement_type: 'adjustment', quantity_delta: Number(item.quantity), unit_cost: item.unit_cost, note: `Pembatalan ${sale.invoice}: ${reason}`, created_at: now });
        }
        sale.voided_at = now;
        sale.void_reason = reason;
        writeLocalDatabase(database);
        return sendJson(res, 200, { ok: true, sale_id: sale.id, voided_at: now, reason });
      });
    }
    if (method === 'POST' && route === '/api/financial-entries') {
      return readJson(req).then((data) => {
        if (!['expense', 'capital', 'income', 'debt', 'debt_payment'].includes(data.entry_type)) throw new ApiError('Jenis pencatatan keuangan tidak valid.', 400);
        const amount = number(data.amount, 'Nominal', { min: 0, allowZero: false });
        const description = String(data.description || '').trim();
        if (!description) throw new ApiError('Keterangan wajib diisi.', 400);
        if (data.entry_type === 'debt_payment') {
          const debt = database.financialEntries.reduce((sum, entry) => sum + (entry.entry_type === 'debt' ? Number(entry.amount) : entry.entry_type === 'debt_payment' ? -Number(entry.amount) : 0), 0);
          if (amount > debt) throw new ApiError('Pembayaran melebihi saldo kewajiban yang tercatat.', 400);
        }
        const entry = { id: localId(database, 'financial'), entry_type: data.entry_type, amount, description, entry_date: data.entry_date || now.slice(0, 10), created_at: now };
        database.financialEntries.push(entry);
        writeLocalDatabase(database);
        return sendJson(res, 201, entry);
      });
    }
    throw new ApiError('Endpoint tidak ditemukan.', 404);
  }
async function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new ApiError('Ukuran permintaan terlalu besar.', 413));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new ApiError('Format JSON tidak valid.', 400)); }
    });
    req.on('error', reject);
  });
}

function number(value, label, { min = 0, allowZero = true } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (!allowZero && parsed === 0)) {
    throw new ApiError(`${label} tidak valid.`, 400);
  }
  return parsed;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function addPaymentSummary(sales, payments, items) {
  return sales.map((sale) => {
    const paid = payments.filter((payment) => Number(payment.sale_id) === Number(sale.id)).reduce((sum, payment) => sum + Number(payment.amount), 0);
    return {
      ...sale,
      paid,
      remaining: sale.voided_at ? 0 : Math.max(0, Number(sale.total) - paid),
      status: sale.voided_at ? 'Dibatalkan' : paid >= Number(sale.total) ? 'Lunas' : paid > 0 ? 'DP' : 'Belum bayar',
      item_count: items.filter((item) => Number(item.sale_id) === Number(sale.id)).length,
    };
  });
}

async function getBaseData() {
  const [products, sales, payments, items, financialEntries] = await Promise.all([
    supabase('products?select=*&archived_at=is.null&order=kind.asc,category.asc,name.asc'),
    supabase('sales?select=*&voided_at=is.null&order=sold_at.desc&limit=1000'),
    supabase('payments?select=sale_id,amount'),
    supabase('sale_items?select=sale_id'),
    supabase('financial_entries?select=*&order=entry_date.desc,id.desc'),
  ]);
  return { products, sales, payments, items, financialEntries };
}

function buildOverview({ products, sales, payments, items }) {
  const month = new Date().toISOString().slice(0, 7);
  const currentSales = sales.filter((sale) => String(sale.sold_at).slice(0, 7) === month);
  const currentPayments = payments;
  const summaries = addPaymentSummary(sales, currentPayments, items);
  const revenue = currentSales.reduce((sum, sale) => sum + Number(sale.total), 0);
  const cogs = currentSales.reduce((sum, sale) => sum + Number(sale.cogs), 0);
  return {
    month,
    revenue,
    cogs,
    profit: revenue - cogs,
    orders: currentSales.length,
    receivables: summaries.reduce((sum, sale) => sum + sale.remaining, 0),
    inventoryValue: products.reduce((sum, product) => sum + Number(product.stock) * Number(product.cost_price), 0),
    productCount: products.length,
    lowStockCount: products.filter((product) => Number(product.stock) <= Number(product.min_stock)).length,
    recentSales: summaries.sort((a, b) => String(b.sold_at).localeCompare(String(a.sold_at))).slice(0, 5),
  };
}

function buildReports({ products, sales, payments, items, financialEntries }) {
  const summaries = addPaymentSummary(sales, payments, items);
  const months = new Map();
  for (const sale of sales) {
    const month = String(sale.sold_at).slice(0, 7);
    const report = months.get(month) || { month, revenue: 0, cogs: 0, profit: 0, orders: 0 };
    report.revenue += Number(sale.total);
    report.cogs += Number(sale.cogs);
    report.profit += Number(sale.total) - Number(sale.cogs);
    report.orders += 1;
    months.set(month, report);
  }
  const revenue = sales.reduce((sum, sale) => sum + Number(sale.total), 0);
  const cogs = sales.reduce((sum, sale) => sum + Number(sale.cogs), 0);
  const expenses = financialEntries.filter((entry) => entry.entry_type === 'expense').reduce((sum, entry) => sum + Number(entry.amount), 0);
  const capital = financialEntries.filter((entry) => entry.entry_type === 'capital').reduce((sum, entry) => sum + Number(entry.amount), 0);
  const otherIncome = financialEntries.filter((entry) => entry.entry_type === 'income').reduce((sum, entry) => sum + Number(entry.amount), 0);
  const debtReceived = financialEntries.filter((entry) => entry.entry_type === 'debt').reduce((sum, entry) => sum + Number(entry.amount), 0);
  const debtPaid = financialEntries.filter((entry) => entry.entry_type === 'debt_payment').reduce((sum, entry) => sum + Number(entry.amount), 0);
  const cash = payments.filter((payment) => sales.some((sale) => Number(sale.id) === Number(payment.sale_id)))
    .reduce((sum, payment) => sum + Number(payment.amount), 0) + capital + otherIncome + debtReceived - expenses - debtPaid;
  const receivables = summaries.reduce((sum, sale) => sum + sale.remaining, 0);
  const inventory = products.reduce((sum, product) => sum + Number(product.stock) * Number(product.cost_price), 0);
  const assets = cash + receivables + inventory;
  const liabilities = debtReceived - debtPaid;
  const netProfit = revenue - cogs + otherIncome - expenses;
  return {
    revenue,
    cogs,
    profit: revenue - cogs,
    orders: sales.length,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-6),
    outstanding: summaries.filter((sale) => sale.remaining > 0),
    expenses,
    netProfit,
    cashFlow: { salesReceipts: cash - capital - otherIncome - debtReceived + expenses + debtPaid, otherIncome, capital, debtReceived, debtPaid, expenses, net: cash },
    balanceSheet: { cash, receivables, inventory, assets, liabilities, capital, retainedEarnings: assets - liabilities - capital },
    financialEntries,
  };
}

async function handleApi(req, res, url) {
  if (STORAGE_MODE === 'local') return handleLocalApi(req, res, url);
  if (STORAGE_MODE !== 'supabase') throw new ApiError('STORAGE_MODE harus bernilai supabase atau local.', 500);
  requireSupabase();
  const route = url.pathname;
  if (req.method === 'GET' && route === '/api/health') {
    await supabase('products?select=id&limit=1');
    return sendJson(res, 200, {
      ok: true,
      status: 'success',
      database: SUPABASE_URL && SUPABASE_KEY ? 'supabase' : 'not-configured',
    });
  }
  if (req.method === 'GET' && route === '/api/overview') {
    return sendJson(res, 200, buildOverview(await getBaseData()));
  }
  if (req.method === 'GET' && route === '/api/products') {
    const products = await supabase('products?select=*&archived_at=is.null&order=kind.asc,category.asc,name.asc');
    return sendJson(res, 200, products.map((product) => ({ ...product, is_low_stock: Number(product.stock) <= Number(product.min_stock) ? 1 : 0 })));
  }
  if (req.method === 'GET' && route === '/api/sales') {
    const [sales, payments, items] = await Promise.all([
      supabase('sales?select=*&order=sold_at.desc&limit=100'),
      supabase('payments?select=sale_id,amount'),
      supabase('sale_items?select=sale_id'),
    ]);
    return sendJson(res, 200, addPaymentSummary(sales, payments, items).slice(0, 100));
  }
  if (req.method === 'GET' && route === '/api/reports') {
    return sendJson(res, 200, buildReports(await getBaseData()));
  }
  if (req.method === 'GET' && route === '/api/production') {
    const orders = await supabase('production_orders?select=*,production_inputs(*)&order=created_at.desc&limit=100');
    return sendJson(res, 200, orders);
  }
  if (req.method === 'GET' && route === '/api/financial-entries') {
    return sendJson(res, 200, await supabase('financial_entries?select=*&order=entry_date.desc,id.desc&limit=200'));
  }
  if (req.method === 'GET' && /^\/api\/sales\/\d+$/.test(route)) {
    const id = Number(route.split('/')[3]);
    const [sales, items, payments] = await Promise.all([
      supabase(`sales?select=*&id=eq.${id}&limit=1`),
      supabase(`sale_items?select=*&sale_id=eq.${id}&order=id.asc`),
      supabase(`payments?select=*&sale_id=eq.${id}&order=paid_at.asc`),
    ]);
    if (!sales.length) return sendJson(res, 404, { error: 'Transaksi tidak ditemukan.' });
    const sale = sales[0];
    const paid = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
    return sendJson(res, 200, { ...sale, items, payments, paid, remaining: sale.voided_at ? 0 : Math.max(0, Number(sale.total) - paid), status: sale.voided_at ? 'Dibatalkan' : paid >= Number(sale.total) ? 'Lunas' : paid > 0 ? 'DP' : 'Belum bayar' });
  }
  if (req.method === 'POST' && route === '/api/products') {
    const data = await readJson(req);
    if (!String(data.name || '').trim() || !['material', 'finished'].includes(data.kind)) {
      throw new ApiError('Nama barang dan jenis persediaan wajib diisi.', 400);
    }
    for (const [field, label] of [['stock', 'Stok'], ['min_stock', 'Batas minimum'], ['cost_price', 'HPP per unit'], ['sale_price', 'Harga jual']]) {
      number(data[field] ?? 0, label);
    }
    const product = await supabase('rpc/stockita_create_product', {
      method: 'POST', body: JSON.stringify({ p_product: data }),
    });
    return sendJson(res, 201, product);
  }
  const archiveProductMatch = route.match(/^\/api\/products\/(\d+)$/);
  if (req.method === 'DELETE' && archiveProductMatch) {
    const data = await readJson(req);
    const reason = String(data.reason || '').trim();
    if (!reason) throw new ApiError('Alasan penghapusan wajib diisi.', 400);
    const result = await supabase('rpc/stockita_archive_product', {
      method: 'POST',
      body: JSON.stringify({ p_product_id: Number(archiveProductMatch[1]), p_reason: reason }),
    });
    return sendJson(res, 200, result);
  }
  if (req.method === 'POST' && route === '/api/stock-adjustments') {
    const data = await readJson(req);
    const productId = number(data.product_id, 'Barang', { min: 1, allowZero: false });
    const delta = Number(data.quantity_delta);
    if (!Number.isFinite(delta) || delta === 0) throw new ApiError('Jumlah perubahan stok harus bukan nol.', 400);
    const product = await supabase('rpc/stockita_adjust_stock', {
      method: 'POST', body: JSON.stringify({ p_product_id: productId, p_quantity_delta: delta, p_note: String(data.note || 'Penyesuaian stok').trim() }),
    });
    return sendJson(res, 200, { ...product, is_low_stock: Number(product.stock) <= Number(product.min_stock) ? 1 : 0 });
  }
  if (req.method === 'POST' && route === '/api/production') {
    const data = await readJson(req);
    const outputProductId = number(data.output_product_id, 'Produk jadi', { min: 1, allowZero: false });
    const outputQuantity = number(data.output_quantity, 'Jumlah produksi', { min: 0, allowZero: false });
    const laborCost = number(data.labor_cost ?? 0, 'Biaya tenaga kerja');
    const overheadCost = number(data.overhead_cost ?? 0, 'Biaya overhead');
    if (!Array.isArray(data.inputs) || data.inputs.length === 0) throw new ApiError('Minimal satu bahan baku harus dipilih.', 400);
    const inputs = data.inputs.map((item) => ({
      product_id: number(item.product_id, 'Bahan baku', { min: 1, allowZero: false }),
      quantity: number(item.quantity, 'Jumlah bahan', { min: 0, allowZero: false }),
    }));
    const production = await supabase('rpc/stockita_create_production', {
      method: 'POST',
      body: JSON.stringify({ p_output_product_id: outputProductId, p_output_quantity: outputQuantity, p_labor_cost: laborCost, p_overhead_cost: overheadCost, p_inputs: inputs, p_note: String(data.note || '').trim() }),
    });
    return sendJson(res, 201, production);
  }
  if (req.method === 'POST' && route === '/api/sales') {
    const data = await readJson(req);
    const customer = String(data.customer || '').trim();
    const lines = Array.isArray(data.items) ? data.items : [];
    if (!customer || lines.length === 0) throw new ApiError('Nama pelanggan dan minimal satu barang wajib diisi.', 400);
    const items = lines.map((line) => ({
      product_id: number(line.product_id, 'Barang', { min: 1, allowZero: false }),
      quantity: number(line.quantity, 'Kuantitas', { min: 0, allowZero: false }),
      unit_price: number(line.unit_price, 'Harga jual'),
    }));
    const initialPayment = number(data.initial_payment ?? 0, 'Pembayaran awal');
    const sale = await supabase('rpc/stockita_create_sale', {
      method: 'POST',
      body: JSON.stringify({ p_customer: customer, p_note: String(data.note || '').trim(), p_items: items, p_initial_payment: initialPayment, p_payment_method: String(data.payment_method || 'Transfer') }),
    });
    return sendJson(res, 201, sale);
  }
  const paymentMatch = route.match(/^\/api\/sales\/(\d+)\/payments$/);
  if (req.method === 'POST' && paymentMatch) {
    const data = await readJson(req);
    const amount = number(data.amount, 'Nominal pembayaran', { min: 0, allowZero: false });
    const result = await supabase('rpc/stockita_add_payment', {
      method: 'POST', body: JSON.stringify({ p_sale_id: Number(paymentMatch[1]), p_amount: amount, p_method: String(data.method || 'Transfer') }),
    });
    return sendJson(res, 201, result);
  }
  const voidMatch = route.match(/^\/api\/sales\/(\d+)\/void$/);
  if (req.method === 'POST' && voidMatch) {
    const data = await readJson(req);
    const reason = String(data.reason || '').trim();
    if (!reason) throw new ApiError('Alasan pembatalan wajib diisi.', 400);
    const result = await supabase('rpc/stockita_void_sale', {
      method: 'POST',
      body: JSON.stringify({ p_sale_id: Number(voidMatch[1]), p_reason: reason }),
    });
    return sendJson(res, 200, result);
  }
  if (req.method === 'POST' && route === '/api/financial-entries') {
    const data = await readJson(req);
    if (!['expense', 'capital', 'income', 'debt', 'debt_payment'].includes(data.entry_type)) throw new ApiError('Jenis pencatatan keuangan tidak valid.', 400);
    const amount = number(data.amount, 'Nominal', { min: 0, allowZero: false });
    const description = String(data.description || '').trim();
    if (!description) throw new ApiError('Keterangan wajib diisi.', 400);
    const entry = await supabase('rpc/stockita_create_financial_entry', {
      method: 'POST',
      body: JSON.stringify({ p_entry_type: data.entry_type, p_amount: amount, p_description: description, p_entry_date: data.entry_date || new Date().toISOString().slice(0, 10) }),
    });
    return sendJson(res, 201, entry);
  }
  return sendJson(res, 404, { error: 'Endpoint tidak ditemukan.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Metode tidak didukung.' });
    const requestedPath = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const filePath = path.resolve(FRONTEND_DIR, requestedPath);
    if (!filePath.startsWith(FRONTEND_DIR + path.sep)) return sendJson(res, 403, { error: 'Akses ditolak.' });
    const body = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error.code === 'ENOENT') return sendJson(res, 404, { error: 'Halaman tidak ditemukan.' });
    if (res.headersSent) return res.destroy();
    const status = error instanceof ApiError ? error.status : 500;
    sendJson(res, status, { error: error.message || 'Terjadi kesalahan pada server.' });
  }
});

server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`Stockita untuk Aster Konveksi berjalan di http://localhost:${PORT}`);
  if (STORAGE_MODE === 'local') console.log(`Database lokal persisten: ${LOCAL_DATABASE_PATH}`);
  else if (SUPABASE_URL && SUPABASE_KEY) console.log(`Database Supabase: ${SUPABASE_URL}`);
  else console.log('Database Supabase belum dikonfigurasi; endpoint API akan mengembalikan error konfigurasi.');
});
