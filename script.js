const state = {
  view: 'dashboard',
  filter: 'all',
  search: '',
  products: [],
  sales: [],
  productionOrders: [],
  overview: null,
  reports: null,
  currentUser: { role: 'owner', display_name: 'Pengguna lokal' },
};

const content = document.getElementById('page-content');
const dialog = document.getElementById('app-dialog');
const toastRegion = document.getElementById('toast-region');
const authScreen = document.getElementById('auth-screen');
const appShell = document.getElementById('app-shell');
const authForm = document.getElementById('login-form');
const authMessage = document.getElementById('auth-message');
const icon = (name) => `<svg aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
const money = (amount) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(amount) || 0);
const quantity = (amount) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(Number(amount) || 0);
const dateTime = (value) => new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
const monthName = (value) => new Intl.DateTimeFormat('id-ID', { month: 'short', year: '2-digit' }).format(new Date(`${value}-15T12:00:00`));
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const navNames = { dashboard: 'Ringkasan', inventory: 'Persediaan', sales: 'Penjualan', production: 'Produksi', reports: 'Laporan' };
const STORAGE_KEY = 'stockita-browser-data-v1';
const supabaseConfig = window.STOCKITA_SUPABASE_CONFIG || {};
const supabaseUrl = String(supabaseConfig.projectUrl || '').replace(/\/+$/, '');
const supabaseKey = String(supabaseConfig.publishableKey || '');
const authStorageKey = `stockita-auth-${supabaseUrl}`;
let authSession = null;
let refreshSessionPromise = null;
let snapshotPromise = null;

function emptyDatabase() {
  return {
    products: [], sales: [], payments: [], items: [], movements: [],
    productionOrders: [], productionInputs: [], financialEntries: [],
    next: { product: 0, sale: 0, payment: 0, item: 0, movement: 0, production: 0, input: 0, financial: 0 },
  };
}

function readDatabase() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyDatabase();
    const database = JSON.parse(raw);
    const initial = emptyDatabase();
    for (const key of Object.keys(initial)) {
      if (key === 'next') continue;
      if (!Array.isArray(database[key])) throw new Error('Struktur data tersimpan tidak valid.');
    }
    database.next = { ...initial.next, ...(database.next || {}) };
    return database;
  } catch (error) {
    throw new Error(`Penyimpanan browser tidak dapat dibaca: ${error.message}`);
  }
}

function writeDatabase(database) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(database));
  } catch (error) {
    throw new Error(`Data gagal disimpan di browser: ${error.message}. Pastikan penyimpanan situs tidak diblokir dan ruang penyimpanan tersedia.`);
  }
}

function nextId(database, name) {
  database.next[name] = Math.max(Number(database.next[name]) || 0, ...database[name === 'item' ? 'items' : name === 'input' ? 'productionInputs' : name === 'movement' ? 'movements' : name === 'financial' ? 'financialEntries' : name === 'production' ? 'productionOrders' : `${name}s`].map((row) => Number(row.id) || 0)) + 1;
  return database.next[name];
}

function validateNumber(value, label, { min = 0, allowZero = true } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (!allowZero && parsed === 0)) throw new Error(`${label} tidak valid.`);
  return parsed;
}

function productStatus(product) {
  return { ...product, is_low_stock: Number(product.stock) <= Number(product.min_stock) ? 1 : 0 };
}

function saleSummary(database, sale) {
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

function overviewFor(database) {
  const sales = database.sales.filter((sale) => !sale.voided_at);
  const products = database.products.filter((product) => !product.archived_at);
  const month = new Date().toISOString().slice(0, 7);
  const currentSales = sales.filter((sale) => String(sale.sold_at).slice(0, 7) === month);
  const summaries = sales.map((sale) => saleSummary(database, sale));
  const revenue = currentSales.reduce((sum, sale) => sum + Number(sale.total), 0);
  const cogs = currentSales.reduce((sum, sale) => sum + Number(sale.cogs), 0);
  return {
    month, revenue, cogs, profit: revenue - cogs, orders: currentSales.length,
    receivables: summaries.reduce((sum, sale) => sum + sale.remaining, 0),
    inventoryValue: products.reduce((sum, product) => sum + Number(product.stock) * Number(product.cost_price), 0),
    productCount: products.length,
    lowStockCount: products.filter((product) => Number(product.stock) <= Number(product.min_stock)).length,
    recentSales: summaries.sort((a, b) => String(b.sold_at).localeCompare(String(a.sold_at))).slice(0, 5),
  };
}

function reportsFor(database) {
  const sales = database.sales.filter((sale) => !sale.voided_at);
  const products = database.products.filter((product) => !product.archived_at);
  const summaries = sales.map((sale) => saleSummary(database, sale));
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
  const sumType = (type) => database.financialEntries.filter((entry) => entry.entry_type === type).reduce((sum, entry) => sum + Number(entry.amount), 0);
  const revenue = sales.reduce((sum, sale) => sum + Number(sale.total), 0);
  const cogs = sales.reduce((sum, sale) => sum + Number(sale.cogs), 0);
  const expenses = sumType('expense');
  const capital = sumType('capital');
  const otherIncome = sumType('income');
  const debtReceived = sumType('debt');
  const debtPaid = sumType('debt_payment');
  const cashReceipts = database.payments.filter((payment) => sales.some((sale) => Number(sale.id) === Number(payment.sale_id)))
    .reduce((sum, payment) => sum + Number(payment.amount), 0);
  const cash = cashReceipts + capital + otherIncome + debtReceived - expenses - debtPaid;
  const receivables = summaries.reduce((sum, sale) => sum + sale.remaining, 0);
  const inventory = products.reduce((sum, product) => sum + Number(product.stock) * Number(product.cost_price), 0);
  const liabilities = debtReceived - debtPaid;
  return {
    revenue, cogs, profit: revenue - cogs, orders: sales.length,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-6),
    outstanding: summaries.filter((sale) => sale.remaining > 0),
    expenses, netProfit: revenue - cogs + otherIncome - expenses,
    cashFlow: { salesReceipts: cashReceipts, otherIncome, capital, debtReceived, debtPaid, expenses, net: cash },
    balanceSheet: { cash, receivables, inventory, assets: cash + receivables + inventory, liabilities, capital, retainedEarnings: cash + receivables + inventory - liabilities - capital },
    financialEntries: database.financialEntries.slice().sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.id - a.id),
  };
}

function localApi(path, options = {}) {
  const route = decodeURIComponent(String(path).split('?')[0]);
  const method = options.method || 'GET';
  const data = options.body ? JSON.parse(options.body) : {};
  const database = readDatabase();
  const now = new Date().toISOString();

  if (method === 'GET' && route === '/api/health') return { database: 'browser' };
  if (method === 'GET' && route === '/api/overview') return overviewFor(database);
  if (method === 'GET' && route === '/api/products') return database.products.filter((product) => !product.archived_at).map(productStatus).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  if (method === 'GET' && route === '/api/sales') return database.sales.map((sale) => saleSummary(database, sale)).sort((a, b) => b.sold_at.localeCompare(a.sold_at)).slice(0, 100);
  if (method === 'GET' && route === '/api/reports') return reportsFor(database);
  if (method === 'GET' && route === '/api/production') return database.productionOrders.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100).map((order) => ({ ...order, production_inputs: database.productionInputs.filter((input) => Number(input.production_id) === Number(order.id)) }));
  if (method === 'GET' && route === '/api/financial-entries') return database.financialEntries.slice().sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.id - a.id).slice(0, 200);

  const saleMatch = route.match(/^\/api\/sales\/([^/]+)$/);
  if (method === 'GET' && saleMatch) {
    const idOrInvoice = saleMatch[1];
    const sale = database.sales.find((entry) => String(entry.id) === idOrInvoice || entry.invoice === idOrInvoice);
    if (!sale) throw new Error('Transaksi tidak ditemukan.');
    return {
      ...saleSummary(database, sale),
      items: database.items.filter((item) => Number(item.sale_id) === Number(sale.id)),
      payments: database.payments.filter((payment) => Number(payment.sale_id) === Number(sale.id)),
    };
  }
  if (method === 'POST' && route === '/api/products') {
    const name = String(data.name || '').trim();
    if (!name || !['material', 'finished'].includes(data.kind)) throw new Error('Nama barang dan jenis persediaan wajib diisi.');
    const sku = String(data.sku || `AST-${Date.now().toString().slice(-7)}`).trim();
    if (database.products.some((item) => item.sku.toLowerCase() === sku.toLowerCase())) throw new Error('Kode SKU sudah digunakan.');
    const barcode = String(data.barcode || '').trim();
    if (barcode && database.products.some((item) => item.barcode === barcode)) throw new Error('Barcode sudah digunakan.');
    const product = {
      id: nextId(database, 'product'), sku, barcode, name,
      category: String(data.category || 'Lainnya').trim(), kind: data.kind, unit: String(data.unit || 'pcs').trim(),
      stock: validateNumber(data.stock ?? 0, 'Stok'), min_stock: validateNumber(data.min_stock ?? 0, 'Batas minimum'),
      cost_price: validateNumber(data.cost_price ?? 0, 'HPP per unit'), sale_price: validateNumber(data.sale_price ?? 0, 'Harga jual'),
      created_at: now,
    };
    database.products.push(product);
    if (product.stock > 0) database.movements.push({ id: nextId(database, 'movement'), product_id: product.id, movement_type: 'initial', quantity_delta: product.stock, unit_cost: product.cost_price, note: 'Saldo awal', created_at: now });
    writeDatabase(database);
    return productStatus(product);
  }
  const productArchiveMatch = route.match(/^\/api\/products\/(\d+)$/);
  if (method === 'DELETE' && productArchiveMatch) {
    const product = database.products.find((item) => Number(item.id) === Number(productArchiveMatch[1]) && !item.archived_at);
    const reason = String(data.reason || '').trim();
    if (!product) throw new Error('Barang tidak ditemukan atau sudah dihapus.');
    if (!reason) throw new Error('Alasan penghapusan wajib diisi.');
    product.archived_at = now;
    product.archive_reason = reason;
    writeDatabase(database);
    return { ok: true, product_id: product.id, archived_at: now, reason };
  }
  if (method === 'POST' && route === '/api/stock-adjustments') {
    const product = database.products.find((item) => Number(item.id) === Number(data.product_id));
    const delta = Number(data.quantity_delta);
    if (!product) throw new Error('Barang tidak ditemukan.');
    if (!Number.isFinite(delta) || delta === 0 || Number(product.stock) + delta < 0) throw new Error('Jumlah perubahan tidak valid atau stok tidak mencukupi.');
    product.stock = Number(product.stock) + delta;
    database.movements.push({ id: nextId(database, 'movement'), product_id: product.id, movement_type: 'adjustment', quantity_delta: delta, unit_cost: product.cost_price, note: String(data.note || 'Penyesuaian stok').trim(), created_at: now });
    writeDatabase(database);
    return productStatus(product);
  }
  if (method === 'POST' && route === '/api/sales') {
    const customer = String(data.customer || '').trim();
    if (!customer || !Array.isArray(data.items) || !data.items.length) throw new Error('Nama pelanggan dan minimal satu barang wajib diisi.');
    const prepared = data.items.map((line) => {
      const product = database.products.find((item) => Number(item.id) === Number(line.product_id));
      if (!product) throw new Error('Barang tidak ditemukan.');
      return { product, quantity: validateNumber(line.quantity, 'Kuantitas', { min: 0, allowZero: false }), unit_price: validateNumber(line.unit_price ?? product.sale_price, 'Harga jual') };
    });
    const requested = new Map();
    for (const line of prepared) requested.set(line.product.id, (requested.get(line.product.id) || 0) + line.quantity);
    for (const [productId, amount] of requested) {
      const product = database.products.find((item) => Number(item.id) === Number(productId));
      if (amount > Number(product.stock)) throw new Error(`Stok ${product.name} tidak mencukupi.`);
    }
    const total = prepared.reduce((sum, line) => sum + line.quantity * line.unit_price, 0);
    const cogs = prepared.reduce((sum, line) => sum + line.quantity * Number(line.product.cost_price), 0);
    const initialPayment = validateNumber(data.initial_payment ?? 0, 'Pembayaran awal');
    if (initialPayment > total) throw new Error('Pembayaran awal melebihi total transaksi.');
    const id = nextId(database, 'sale');
    const invoice = `AST-${now.slice(0, 10).replaceAll('-', '')}-${String(id).padStart(5, '0')}`;
    const sale = { id, invoice, customer, note: String(data.note || '').trim(), sold_at: now, total, cogs, voided_at: null, void_reason: null };
    database.sales.push(sale);
    for (const line of prepared) {
      const lineCogs = line.quantity * Number(line.product.cost_price);
      database.items.push({ id: nextId(database, 'item'), sale_id: id, product_id: line.product.id, product_name: line.product.name, quantity: line.quantity, unit_price: line.unit_price, unit_cost: line.product.cost_price, subtotal: line.quantity * line.unit_price, line_cogs: lineCogs });
      line.product.stock = Number(line.product.stock) - line.quantity;
      database.movements.push({ id: nextId(database, 'movement'), product_id: line.product.id, movement_type: 'sale', quantity_delta: -line.quantity, unit_cost: line.product.cost_price, note: `Penjualan ${invoice}`, created_at: now });
    }
    if (initialPayment > 0) database.payments.push({ id: nextId(database, 'payment'), sale_id: id, amount: initialPayment, method: String(data.payment_method || 'Transfer'), paid_at: now });
    writeDatabase(database);
    return sale;
  }
  const paymentMatch = route.match(/^\/api\/sales\/(\d+)\/payments$/);
  if (method === 'POST' && paymentMatch) {
    const sale = database.sales.find((entry) => Number(entry.id) === Number(paymentMatch[1]) && !entry.voided_at);
    if (!sale) throw new Error('Transaksi tidak ditemukan atau telah dibatalkan.');
    const amount = validateNumber(data.amount, 'Nominal pembayaran', { min: 0, allowZero: false });
    const paid = database.payments.filter((entry) => Number(entry.sale_id) === Number(sale.id)).reduce((sum, entry) => sum + Number(entry.amount), 0);
    if (amount > Number(sale.total) - paid) throw new Error('Nominal pembayaran melebihi sisa tagihan.');
    database.payments.push({ id: nextId(database, 'payment'), sale_id: sale.id, amount, method: String(data.method || 'Transfer'), paid_at: now });
    writeDatabase(database);
    return { ok: true, remaining: Number(sale.total) - paid - amount };
  }
  if (method === 'POST' && route === '/api/production') {
    const output = database.products.find((item) => Number(item.id) === Number(data.output_product_id) && item.kind === 'finished');
    const outputQuantity = validateNumber(data.output_quantity, 'Jumlah produksi', { min: 0, allowZero: false });
    const labor = validateNumber(data.labor_cost ?? 0, 'Biaya tenaga kerja');
    const overhead = validateNumber(data.overhead_cost ?? 0, 'Biaya overhead');
    if (!output) throw new Error('Produk barang jadi tidak ditemukan.');
    if (!Array.isArray(data.inputs) || !data.inputs.length) throw new Error('Minimal satu bahan baku harus dipilih.');
    const requested = new Map();
    for (const line of data.inputs) {
      const productId = Number(line.product_id);
      const amount = validateNumber(line.quantity, 'Jumlah bahan', { min: 0, allowZero: false });
      requested.set(productId, (requested.get(productId) || 0) + amount);
    }
    const inputs = [...requested].map(([productId, amount]) => {
      const product = database.products.find((item) => Number(item.id) === productId && item.kind === 'material');
      if (!product || amount > Number(product.stock)) throw new Error('Bahan baku tidak ditemukan atau stok tidak mencukupi.');
      return { product, quantity: amount };
    });
    const materialCost = inputs.reduce((sum, line) => sum + line.quantity * Number(line.product.cost_price), 0);
    const totalCost = materialCost + labor + overhead;
    const unitCost = Math.round(totalCost / outputQuantity * 100) / 100;
    const id = nextId(database, 'production');
    database.productionOrders.push({ id, output_product_id: output.id, output_product_name: output.name, output_quantity: outputQuantity, material_cost: materialCost, labor_cost: labor, overhead_cost: overhead, total_cost: totalCost, unit_cost: unitCost, note: String(data.note || ''), created_at: now });
    for (const line of inputs) {
      line.product.stock = Number(line.product.stock) - line.quantity;
      database.productionInputs.push({ id: nextId(database, 'input'), production_id: id, product_id: line.product.id, product_name: line.product.name, quantity: line.quantity, unit_cost: line.product.cost_price, line_cost: line.quantity * Number(line.product.cost_price) });
      database.movements.push({ id: nextId(database, 'movement'), product_id: line.product.id, movement_type: 'production_input', quantity_delta: -line.quantity, unit_cost: line.product.cost_price, note: `Produksi #${id}`, created_at: now });
    }
    output.stock = Number(output.stock) + outputQuantity;
    output.cost_price = unitCost;
    database.movements.push({ id: nextId(database, 'movement'), product_id: output.id, movement_type: 'production_output', quantity_delta: outputQuantity, unit_cost: unitCost, note: `Hasil produksi #${id}`, created_at: now });
    writeDatabase(database);
    return { id, output_product_id: output.id, output_quantity: outputQuantity, material_cost: materialCost, labor_cost: labor, overhead_cost: overhead, total_cost: totalCost, unit_cost: unitCost, created_at: now };
  }
  const voidMatch = route.match(/^\/api\/sales\/(\d+)\/void$/);
  if (method === 'POST' && voidMatch) {
    const sale = database.sales.find((entry) => Number(entry.id) === Number(voidMatch[1]));
    const reason = String(data.reason || '').trim();
    if (!sale || sale.voided_at) throw new Error('Transaksi tidak ditemukan atau sudah dibatalkan.');
    if (!reason) throw new Error('Alasan pembatalan wajib diisi.');
    for (const item of database.items.filter((entry) => Number(entry.sale_id) === Number(sale.id))) {
      const product = database.products.find((entry) => Number(entry.id) === Number(item.product_id));
      if (!product) throw new Error(`Barang ${item.product_name} sudah tidak tersedia; stok tidak dapat dikembalikan.`);
      product.stock = Number(product.stock) + Number(item.quantity);
      database.movements.push({ id: nextId(database, 'movement'), product_id: product.id, movement_type: 'adjustment', quantity_delta: Number(item.quantity), unit_cost: item.unit_cost, note: `Pembatalan ${sale.invoice}: ${reason}`, created_at: now });
    }
    sale.voided_at = now;
    sale.void_reason = reason;
    writeDatabase(database);
    return { ok: true, sale_id: sale.id, voided_at: now, reason };
  }
  if (method === 'POST' && route === '/api/financial-entries') {
    if (!['expense', 'capital', 'income', 'debt', 'debt_payment'].includes(data.entry_type)) throw new Error('Jenis pencatatan keuangan tidak valid.');
    const amount = validateNumber(data.amount, 'Nominal', { min: 0, allowZero: false });
    const description = String(data.description || '').trim();
    if (!description) throw new Error('Keterangan wajib diisi.');
    if (data.entry_type === 'debt_payment') {
      const debt = database.financialEntries.reduce((sum, entry) => sum + (entry.entry_type === 'debt' ? Number(entry.amount) : entry.entry_type === 'debt_payment' ? -Number(entry.amount) : 0), 0);
      if (amount > debt) throw new Error('Pembayaran melebihi saldo kewajiban yang tercatat.');
    }
    const entry = { id: nextId(database, 'financial'), entry_type: data.entry_type, amount, description, entry_date: data.entry_date || now.slice(0, 10), created_at: now };
    database.financialEntries.push(entry);
    writeDatabase(database);
    return entry;
  }
  throw new Error('Endpoint tidak ditemukan.');
}

function setAuthMessage(message, isError = false) {
  authMessage.textContent = message;
  authMessage.classList.toggle('is-error', isError);
}

function saveAuthSession(session) {
  try {
    localStorage.setItem(authStorageKey, JSON.stringify(session));
    authSession = session;
  } catch (error) {
    throw new Error(`Sesi tidak dapat disimpan di browser: ${error.message}. Aktifkan penyimpanan situs untuk melanjutkan.`);
  }
}

function clearAuthSession() {
  try {
    localStorage.removeItem(authStorageKey);
  } catch (error) {
    throw new Error(`Sesi tidak dapat dihapus dari browser: ${error.message}.`);
  }
  authSession = null;
}

function parseSupabaseResponse(response, payload) {
  if (!response.ok) {
    const code = String(payload?.code || '');
    const message = payload?.msg || payload?.message || payload?.error_description || payload?.details || payload?.hint || payload?.error;
    if (
      response.status === 403
      || code === '42501'
      || code === 'PGRST202'
      || code === 'PGRST205'
      || code === '42P01'
      || /permission denied|could not find the function|schema cache|relation .* does not exist/i.test(String(message || ''))
    ) {
      throw new Error('Database Supabase belum memiliki skema atau izin akses terbaru. Buka Supabase → SQL Editor, jalankan ulang seluruh backend/database.sql, lalu muat ulang Stockita.');
    }
    throw new Error(message || `Permintaan Supabase gagal (${response.status}).`);
  }
  return payload;
}

async function fetchFromSupabase(url, options) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Koneksi ke Supabase melewati batas waktu. Periksa internet dan coba lagi.');
    throw new Error(`Tidak dapat terhubung ke Supabase. Periksa URL project, internet, dan izin jaringan/CORS browser: ${error.message}`);
  } finally {
    window.clearTimeout(timeout);
  }
}

async function authRequest(path, body) {
  const response = await fetchFromSupabase(`${supabaseUrl}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: supabaseKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error(`Respons autentikasi tidak valid (${response.status}).`); }
  return parseSupabaseResponse(response, payload);
}

async function refreshAuthSession() {
  if (!authSession?.refresh_token) throw new Error('Sesi berakhir. Silakan masuk kembali.');
  if (!refreshSessionPromise) {
    refreshSessionPromise = authRequest('token?grant_type=refresh_token', { refresh_token: authSession.refresh_token })
      .then((session) => {
        session.expires_at = session.expires_at || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600);
        saveAuthSession(session);
        return session;
      })
      .catch((error) => {
        clearAuthSession();
        throw error;
      })
      .finally(() => { refreshSessionPromise = null; });
  }
  return refreshSessionPromise;
}

async function currentAccessToken() {
  if (!authSession?.access_token) throw new Error('Sesi masuk tidak ditemukan. Silakan masuk kembali.');
  if (Number(authSession.expires_at || 0) <= Math.floor(Date.now() / 1000) + 60) await refreshAuthSession();
  return authSession.access_token;
}

async function supabaseFetch(path, options = {}, retry = true) {
  const token = await currentAccessToken();
  const response = await fetchFromSupabase(`${supabaseUrl}${path}`, {
    ...options,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  let payload = null;
  const responseText = await response.text();
  if (responseText) {
    try { payload = JSON.parse(responseText); } catch { throw new Error(`Respons database tidak valid (${response.status}).`); }
  }
  if (response.status === 401 && retry) {
    await refreshAuthSession();
    return supabaseFetch(path, options, false);
  }
  return parseSupabaseResponse(response, payload);
}

async function supabaseFetchAll(path, pageSize = 500) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const separator = path.includes('?') ? '&' : '?';
    const page = await supabaseFetch(`${path}${separator}limit=${pageSize}&offset=${offset}`);
    if (!Array.isArray(page)) throw new Error('Format data database tidak valid.');
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function loadDatabaseSnapshot() {
  if (!snapshotPromise) {
    snapshotPromise = Promise.all([
      supabaseFetchAll('/rest/v1/products?select=*&order=kind.asc,name.asc,id.asc'),
      supabaseFetchAll('/rest/v1/sales?select=*&order=sold_at.desc,id.desc'),
      supabaseFetchAll('/rest/v1/payments?select=*&order=paid_at.desc,id.desc'),
      supabaseFetchAll('/rest/v1/sale_items?select=*&order=id.asc'),
      supabaseFetchAll('/rest/v1/financial_entries?select=*&order=entry_date.desc,id.desc'),
    ])
      .then(([products, sales, payments, items, financialEntries]) => ({ products, sales, payments, items, financialEntries }))
      .catch((error) => {
        snapshotPromise = null;
        throw error;
      });
  }
  return snapshotPromise;
}

async function api(path, options = {}) {
  const route = decodeURIComponent(String(path).split('?')[0]);
  const method = options.method || 'GET';
  const data = options.body ? JSON.parse(options.body) : {};
  const rpc = (name, args) => supabaseFetch(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });

  if (method === 'GET' && route === '/api/health') {
    await supabaseFetch('/rest/v1/products?select=id&limit=1');
    return { database: 'supabase' };
  }
  if (method === 'GET' && route === '/api/products') {
    const products = await supabaseFetch('/rest/v1/products?select=*&archived_at=is.null&order=kind.asc,name.asc');
    return products.map(productStatus);
  }
  if (method === 'GET' && (route === '/api/overview' || route === '/api/reports' || route === '/api/sales')) {
    const snapshot = await loadDatabaseSnapshot();
    if (route === '/api/overview') return overviewFor(snapshot);
    if (route === '/api/reports') return reportsFor(snapshot);
    return snapshot.sales.map((sale) => saleSummary(snapshot, sale)).sort((a, b) => b.sold_at.localeCompare(a.sold_at)).slice(0, 100);
  }
  if (method === 'GET' && route === '/api/production') {
    return supabaseFetch('/rest/v1/production_orders?select=*,production_inputs(*)&order=created_at.desc&limit=100');
  }
  if (method === 'GET' && route === '/api/financial-entries') {
    return supabaseFetch('/rest/v1/financial_entries?select=*&order=entry_date.desc,id.desc&limit=200');
  }
  const saleMatch = route.match(/^\/api\/sales\/([^/]+)$/);
  if (method === 'GET' && saleMatch) {
    const identifier = saleMatch[1];
    const field = /^\d+$/.test(identifier) ? 'id' : 'invoice';
    const query = new URLSearchParams({ select: '*', [field]: `eq.${identifier}`, limit: '1' });
    const sales = await supabaseFetch(`/rest/v1/sales?${query}`);
    const sale = sales[0];
    if (!sale) throw new Error('Transaksi tidak ditemukan.');
    const [payments, items] = await Promise.all([
      supabaseFetch(`/rest/v1/payments?select=*&sale_id=eq.${sale.id}&order=paid_at.asc`),
      supabaseFetch(`/rest/v1/sale_items?select=*&sale_id=eq.${sale.id}`),
    ]);
    const snapshot = { sales, payments, items };
    return { ...saleSummary(snapshot, sale), items, payments };
  }
  if (method === 'POST' && route === '/api/products') return productStatus(await rpc('stockita_create_product', { p_product: data }));
  const archiveMatch = route.match(/^\/api\/products\/(\d+)$/);
  if (method === 'DELETE' && archiveMatch) {
    return rpc('stockita_archive_product', { p_product_id: Number(archiveMatch[1]), p_reason: data.reason });
  }
  if (method === 'POST' && route === '/api/stock-adjustments') {
    return productStatus(await rpc('stockita_adjust_stock', {
      p_product_id: Number(data.product_id), p_quantity_delta: Number(data.quantity_delta), p_note: data.note || '',
    }));
  }
  if (method === 'POST' && route === '/api/sales') {
    return rpc('stockita_create_sale', {
      p_customer: data.customer, p_note: data.note || '', p_items: data.items,
      p_initial_payment: Number(data.initial_payment), p_payment_method: data.payment_method || 'Transfer',
    });
  }
  const paymentMatch = route.match(/^\/api\/sales\/(\d+)\/payments$/);
  if (method === 'POST' && paymentMatch) {
    return rpc('stockita_add_payment', { p_sale_id: Number(paymentMatch[1]), p_amount: Number(data.amount), p_method: data.method || 'Transfer' });
  }
  if (method === 'POST' && route === '/api/production') {
    return rpc('stockita_create_production', {
      p_output_product_id: Number(data.output_product_id), p_output_quantity: Number(data.output_quantity),
      p_labor_cost: Number(data.labor_cost), p_overhead_cost: Number(data.overhead_cost),
      p_inputs: data.inputs, p_note: data.note || '',
    });
  }
  const voidMatch = route.match(/^\/api\/sales\/(\d+)\/void$/);
  if (method === 'POST' && voidMatch) {
    return rpc('stockita_void_sale', { p_sale_id: Number(voidMatch[1]), p_reason: data.reason });
  }
  if (method === 'POST' && route === '/api/financial-entries') {
    return rpc('stockita_create_financial_entry', {
      p_entry_type: data.entry_type, p_amount: Number(data.amount),
      p_description: data.description, p_entry_date: data.entry_date,
    });
  }
  throw new Error('Endpoint aplikasi tidak dikenal.');
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  document.getElementById('crumb-current').textContent = navNames[view];
  render();
}

async function refreshData() {
  snapshotPromise = null;
  const storageStatus = document.querySelector('.sidebar-bottom span:nth-child(2)');
  const storageNote = document.querySelector('.sidebar-bottom small');
  const userLabel = document.getElementById('user-label');
  const health = await api('/api/health');
  if (storageStatus) {
    storageStatus.textContent = health.database === 'supabase'
      ? 'Database PostgreSQL terpusat'
      : health.database === 'local' ? 'Penyimpanan server lokal' : 'Data tersimpan di browser ini';
  }
  if (storageNote) {
    storageNote.textContent = health.database === 'supabase'
      ? 'STOCKITA · ASTER KONVEKSI · POSTGRESQL'
      : health.database === 'local' ? 'STOCKITA · DATA DI SERVER INI' : 'STOCKITA · DATA DI BROWSER INI';
  }
  if (userLabel) {
    userLabel.textContent = authSession?.user?.email || 'Pengguna terautentikasi';
  }
  const requests = [
    api('/api/overview'), api('/api/products'), api('/api/sales'), api('/api/reports'), api('/api/production'),
  ];
  const [overview, products, sales, reports, productionOrders] = await Promise.all(requests);
  state.overview = overview;
  state.products = products;
  state.sales = sales;
  state.reports = reports;
  state.productionOrders = productionOrders;
  document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('is-active', button.dataset.view === state.view));
  document.getElementById('crumb-current').textContent = navNames[state.view];
  render();
}

function showAuthenticatedApp() {
  authScreen.hidden = true;
  appShell.hidden = false;
  state.currentUser.display_name = authSession?.user?.email || 'Pengguna terautentikasi';
  authForm.reset();
  setAuthMessage('');
}

function showLogin(message = 'Masuk menggunakan akun yang telah diundang oleh admin.', isError = false) {
  appShell.hidden = true;
  authScreen.hidden = false;
  setAuthMessage(message, isError);
}

async function initializeSupabaseApp() {
  if (!supabaseUrl || !supabaseKey || !/^https:\/\//i.test(supabaseUrl)) {
    showLogin('Konfigurasi belum tersedia. Isi projectUrl dan publishableKey di frontend/supabase-config.js, lalu buka ulang halaman.');
    return;
  }
  authForm.hidden = false;
  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = authForm.querySelector('[type="submit"]');
    submitButton.disabled = true;
    setAuthMessage('Menghubungkan ke database…');
    try {
      const values = Object.fromEntries(new FormData(authForm));
      const session = await authRequest('token?grant_type=password', { email: values.email, password: values.password });
      session.expires_at = session.expires_at || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600);
      saveAuthSession(session);
      showAuthenticatedApp();
    } catch (error) {
      showLogin(error.message, true);
      return;
    } finally {
      submitButton.disabled = false;
    }
    try {
      await refreshData();
    } catch (error) {
      content.innerHTML = `<div class="loading-state"><p>${escapeHtml(error.message)}</p><button class="button button-secondary" data-action="retry">Coba lagi</button></div>`;
    }
  });

  document.getElementById('sign-out').addEventListener('click', async () => {
    const accessToken = authSession?.access_token;
    let logoutError = null;
    try {
      if (accessToken) {
        const response = await fetchFromSupabase(`${supabaseUrl}/auth/v1/logout`, {
          method: 'POST',
          headers: { apikey: supabaseKey, Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) throw new Error(`Keluar gagal (${response.status}).`);
      }
    } catch (error) {
      logoutError = error;
    }
    try {
      clearAuthSession();
      showLogin(logoutError ? 'Sesi lokal telah dihapus, tetapi server tidak mengonfirmasi logout. Tutup browser jika perangkat ini digunakan bersama.' : 'Anda telah keluar dari Stockita.');
      if (logoutError) notify(logoutError.message, true);
    } catch (error) {
      notify(error.message, true);
    }
  });

  try {
    const stored = localStorage.getItem(authStorageKey);
    authSession = stored ? JSON.parse(stored) : null;
  } catch (error) {
    showLogin(`Penyimpanan sesi browser tidak dapat diakses: ${error.message}. Aktifkan penyimpanan situs untuk melanjutkan.`);
    return;
  }
  if (!authSession?.refresh_token) {
    showLogin('Masuk menggunakan akun yang telah diundang oleh admin.');
    return;
  }
  try {
    if (Number(authSession.expires_at || 0) <= Math.floor(Date.now() / 1000) + 60) await refreshAuthSession();
  } catch (error) {
    try { clearAuthSession(); } catch { /* Show the original authentication or database error. */ }
    showLogin(error.message);
    return;
  }
  showAuthenticatedApp();
  try {
    await refreshData();
  } catch (error) {
    content.innerHTML = `<div class="loading-state"><p>${escapeHtml(error.message)}</p><button class="button button-secondary" data-action="retry">Coba lagi</button></div>`;
  }
}

function pageHeading(eyebrow, title, subtitle, action = '') {
  return `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="page-subtitle">${subtitle}</p></div>${action}</div>`;
}

function metric(label, value, note, symbol, accent = false) {
  return `<article class="metric${accent ? ' metric-accent' : ''}"><span class="metric-label">${icon(symbol)}${label}</span><strong class="metric-value">${value}</strong><span class="metric-foot">${note}</span></article>`;
}

function statusBadge(status) {
  const className = status === 'Dibatalkan' ? 'status-void' : status === 'Lunas' ? 'status-paid' : status === 'DP' ? 'status-partial' : 'status-unpaid';
  return `<span class="status ${className}">${escapeHtml(status)}</span>`;
}

function render() {
  if (!state.overview) return;
  const pages = {
    dashboard: renderDashboard,
    inventory: renderInventory,
    sales: renderSales,
    production: renderProduction,
    reports: renderReports,
  };
  content.innerHTML = pages[state.view]();
}

function renderDashboard() {
  const overview = state.overview;
  const lowStock = state.products.filter((product) => product.stock <= product.min_stock).slice(0, 5);
  const recent = overview.recentSales || [];
  const revenue = `<span class="numeric">${money(overview.revenue)}</span>`;
  const dashboardAction = state.currentUser?.role !== 'warehouse' ? `<button class="button button-primary" data-action="create-sale">${icon('plus')} Catat penjualan</button>` : '';
  return `${pageHeading(`ASTER KONVEKSI · ${monthName(overview.month)}`, 'Ringkasan', 'Pantau pergerakan usaha dan kondisi persediaan.', dashboardAction) }
    <section class="dashboard-hero" aria-label="Visual ringkasan usaha">
      <div class="dashboard-hero-copy">
        <p class="eyebrow">Ruang kerja Aster</p>
        <h2>Kelola pesanan, stok, dan penjualan dengan lebih tenang.</h2>
        <p>Semua aktivitas penting usaha Anda tersusun rapi dalam satu tampilan yang ringan, jelas, dan nyaman dilihat setiap hari.</p>
      </div>
      <div class="dashboard-hero-panel" aria-hidden="true">
        <svg class="hero-thread-art" viewBox="0 0 160 128" fill="none">
          <path d="M37 34h54M42 28h44l8 9v54l-8 9H42l-8-9V37l8-9Z" />
          <path d="M42 38c10 9 34 9 44 0M42 90c10-9 34-9 44 0M46 49h36M46 57h36M46 65h36M46 73h36M46 81h36" />
          <path d="m105 20 24 24M102 23l-5 18 10-10 18-5M98 41l-8 15" />
          <path d="M97 56c10 11 8 24-3 33" stroke-dasharray="3 5" />
          <path d="M117 84c9-11 20-12 28-8-2 12-10 20-22 20M116 85c-1-11 4-19 14-24 7 11 6 20-1 29" />
        </svg>
        <div class="hero-badge hero-badge-top">Aster</div>
        <div class="hero-metric">
          <span>Omzet bulan ini</span>
          <strong>${money(overview.revenue)}</strong>
        </div>
        <div class="hero-mini-grid">
          <div><small>Stok aman</small><strong>${overview.productCount}</strong></div>
          <div><small>Order</small><strong>${overview.orders}</strong></div>
        </div>
      </div>
    </section>
    <section class="metric-grid" aria-label="Ringkasan bulan ini">
      ${metric('Omzet bulan ini', revenue, `${overview.orders} transaksi tercatat`, 'arrow-up', true)}
      ${metric('Laba kotor', money(overview.profit), `Setelah HPP ${money(overview.cogs)}`, 'chart')}
      ${metric('Piutang berjalan', money(overview.receivables), 'Sisa tagihan pelanggan', 'wallet')}
      ${metric('Nilai persediaan', money(overview.inventoryValue), `${overview.productCount} jenis barang · ${overview.lowStockCount} perlu restok`, 'box')}
    </section>
    <section class="dashboard-grid">
      <article class="panel">
        <header class="panel-header"><h2>Penjualan terbaru</h2><button class="panel-link" data-action="view-sales">Semua transaksi <span aria-hidden="true">→</span></button></header>
        ${recent.length ? `<div class="table-wrap"><table><thead><tr><th>Transaksi</th><th>Pelanggan</th><th>Total</th><th>Status</th></tr></thead><tbody>${recent.map((sale) => `<tr><td><button class="panel-link" data-action="sale-detail" data-id="${sale.id}">${escapeHtml(sale.invoice)}</button><span class="secondary-line">${dateTime(sale.sold_at)}</span></td><td>${escapeHtml(sale.customer)}</td><td class="numeric">${money(sale.total)}</td><td>${statusBadge(sale.status)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">Belum ada transaksi. Penjualan pertama akan muncul di sini.</div>'}
      </article>
      <article class="panel">
        <header class="panel-header"><h2>Perlu perhatian</h2><button class="panel-link" data-action="view-inventory">Persediaan <span aria-hidden="true">→</span></button></header>
        ${lowStock.length ? `<div class="stock-list">${lowStock.map((product) => `<div class="stock-item"><div><span class="stock-item-name">${escapeHtml(product.name)}</span><span class="stock-item-meta">Batas minimum ${quantity(product.min_stock)} ${escapeHtml(product.unit)}</span></div><div class="stock-count">${quantity(product.stock)} ${escapeHtml(product.unit)}<span class="secondary-line">tersisa</span></div></div>`).join('')}</div>` : '<div class="empty-state">Semua barang berada di atas batas minimum.</div>'}
      </article>
    </section>`;
}

function renderInventory() {
  const query = state.search.trim().toLocaleLowerCase('id');
  const products = state.products.filter((product) => (state.filter === 'all' || product.kind === state.filter)
    && `${product.name} ${product.sku} ${product.barcode || ''} ${product.category}`.toLocaleLowerCase('id').includes(query));
  const filters = [['all', 'Semua'], ['material', 'Bahan baku'], ['finished', 'Barang jadi']];
  const canManage = ['owner', 'warehouse'].includes(state.currentUser?.role);
  const canDelete = state.currentUser?.role === 'owner';
  const rows = products.map((product) => `<tr>
    <td><span class="item-title">${escapeHtml(product.name)}</span><span class="secondary-line sku">${escapeHtml(product.sku)} · ${escapeHtml(product.barcode || 'Tanpa barcode')} · ${escapeHtml(product.category)}</span></td>
    <td><span class="kind-label">${product.kind === 'material' ? 'Bahan baku' : 'Barang jadi'}</span></td>
    <td class="numeric"><strong>${quantity(product.stock)}</strong> ${escapeHtml(product.unit)}<span class="secondary-line">Min. ${quantity(product.min_stock)} ${escapeHtml(product.unit)}</span></td>
    <td class="numeric">${money(product.cost_price)}</td><td class="numeric">${product.sale_price ? money(product.sale_price) : '<span class="muted">Belum diatur</span>'}</td>
    <td>${product.is_low_stock ? '<span class="status status-low">Stok menipis</span>' : '<span class="status status-stock">Tersedia</span>'}</td>
    <td>${canManage ? `<div class="row-actions"><button class="button button-quiet" data-action="update-stock" data-id="${product.id}" aria-label="Sesuaikan stok ${escapeHtml(product.name)}">Sesuaikan stok</button>${canDelete ? `<button class="button button-danger" data-action="delete-product" data-id="${product.id}" aria-label="Hapus persediaan ${escapeHtml(product.name)}">Hapus</button>` : ''}</div>` : ''}</td>
  </tr>`).join('');
  return `${pageHeading('BAHAN BAKU & PRODUK', 'Persediaan', 'Bahan produksi dan barang jadi dalam satu catatan stok.', canManage ? `<button class="button button-primary" data-action="create-product">${icon('plus')} Tambah barang</button>` : '')}
    <div class="toolbar"><div class="toolbar-left"><label class="search-field">${icon('search')}<input id="product-search" type="search" placeholder="Cari nama atau SKU" value="${escapeHtml(state.search)}" aria-label="Cari persediaan"></label>
      <div class="segmented" aria-label="Filter jenis persediaan">${filters.map(([value, label]) => `<button class="segment${state.filter === value ? ' is-active' : ''}" data-filter="${value}">${label}</button>`).join('')}</div></div>
      <div class="toolbar-right"><span class="muted" style="font-size:10px">${products.length} dari ${state.products.length} barang</span></div></div>
    <section class="panel table-panel"><div class="table-wrap"><table><thead><tr><th>Barang</th><th>Jenis</th><th>Stok tersedia</th><th>HPP / unit</th><th>Harga jual</th><th>Kondisi</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7"><div class="empty-state">${state.products.length ? 'Barang tidak ditemukan.' : 'Belum ada barang terdaftar.'}</div></td></tr>`}</tbody></table></div></section>`;
}

function renderSales() {
  const open = state.sales.filter((sale) => sale.remaining > 0);
  const rows = state.sales.map((sale) => `<tr>
    <td><button class="panel-link" data-action="sale-detail" data-id="${sale.id}">${escapeHtml(sale.invoice)}</button><span class="secondary-line">${dateTime(sale.sold_at)}</span></td>
    <td>${escapeHtml(sale.customer)}<span class="secondary-line">${sale.item_count} jenis barang</span></td>
    <td class="numeric">${money(sale.total)}</td><td class="numeric">${money(sale.paid)}</td><td class="numeric">${money(sale.remaining)}</td><td>${statusBadge(sale.status)}</td>
    <td><button class="button button-quiet" data-action="sale-detail" data-id="${sale.id}">Detail</button></td></tr>`).join('');
  return `${pageHeading('PESANAN & PEMBAYARAN', 'Penjualan', 'Catat pesanan pelanggan, DP, dan pelunasan dalam satu alur.', `<button class="button button-primary" data-action="create-sale">${icon('plus')} Catat penjualan</button>`)}
    <section class="panel table-panel"><div class="sales-summary"><span>Transaksi <strong>${state.sales.length}</strong></span><span>Belum lunas <strong>${open.length}</strong></span><span>Sisa piutang <strong>${money(state.sales.reduce((sum, sale) => sum + sale.remaining, 0))}</strong></span></div>
    <div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Pelanggan</th><th>Total</th><th>Dibayar</th><th>Sisa</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7"><div class="empty-state">Belum ada penjualan. Transaksi baru akan tersimpan bersama HPP dan perubahan stok.</div></td></tr>'}</tbody></table></div></section>`;
}

function renderProduction() {
  const orders = state.productionOrders || [];
  const rows = orders.map((order) => {
    const product = state.products.find((item) => item.id === order.output_product_id);
    const materials = (order.production_inputs || []).map((input) => `${escapeHtml(input.product_name)} (${quantity(input.quantity)})`).join(', ');
    return `<tr><td>PRO-${String(order.id).padStart(5, '0')}<span class="secondary-line">${dateTime(order.created_at)}</span></td>
      <td>${escapeHtml(product?.name || order.output_product_name || `Produk #${order.output_product_id}`)}<span class="secondary-line">${materials || 'Tidak ada rincian bahan'}</span></td><td class="numeric">${quantity(order.output_quantity)}</td>
      <td class="numeric">${money(order.total_cost)}</td><td class="numeric">${money(order.unit_cost)}</td></tr>`;
  }).join('');
  return `${pageHeading('PROSES & HPP KONVEKSI', 'Produksi', 'Konversi bahan baku menjadi barang jadi dengan biaya bahan, tenaga kerja, dan overhead.', `<button class="button button-primary" data-action="create-production">${icon('plus')} Catat produksi</button>`)}
    <section class="panel table-panel"><header class="panel-header"><h2>Riwayat produksi</h2><span class="muted">${orders.length} batch terbaru</span></header>
      <div class="table-wrap"><table><thead><tr><th>Batch</th><th>Produk jadi</th><th>Jumlah</th><th>Total biaya</th><th>HPP / unit</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5"><div class="empty-state">Belum ada proses produksi tercatat.</div></td></tr>'}</tbody></table></div></section>`;
}

function renderReports() {
  const report = state.reports;
  const months = report.months || [];
  const highest = Math.max(1, ...months.map((entry) => entry.revenue));
  const outstanding = report.outstanding || [];
  const balance = report.balanceSheet || {};
  const cashFlow = report.cashFlow || {};
  const entries = report.financialEntries || [];
  const entryRows = entries.map((entry) => `<tr><td>${dateTime(entry.entry_date)}</td><td>${escapeHtml(entry.description)}</td>
    <td>${({ expense: 'Biaya', capital: 'Modal pemilik', income: 'Pendapatan lain', debt: 'Penerimaan pinjaman', debt_payment: 'Pembayaran kewajiban' })[entry.entry_type] || 'Lainnya'}</td><td class="numeric">${money(entry.amount)}</td></tr>`).join('');
  return `${pageHeading('AKUNTANSI & ARUS TRANSAKSI', 'Laporan', 'Laporan laba rugi, neraca sederhana, arus kas, dan piutang.', `<button class="button button-primary" data-action="create-financial-entry">${icon('plus')} Catat kas / biaya</button>`)}
    <section class="report-hero"><div><p class="eyebrow">TOTAL TEREKAM</p><p class="report-main-value">${money(report.profit)}</p><small>Laba kotor · omzet dikurangi HPP</small></div>
      <div class="report-stat"><span>Omzet</span><strong>${money(report.revenue)}</strong></div><div class="report-stat"><span>Biaya usaha</span><strong>${money(report.expenses)}</strong></div><div class="report-stat"><span>Laba bersih*</span><strong>${money(report.netProfit)}</strong></div></section>
    <section class="report-grid"><article class="panel"><header class="panel-header"><h2>Performa bulanan</h2><span class="muted" style="font-size:9px">Omzet · 6 bulan terakhir</span></header>
      ${months.length ? `<div class="chart-list">${months.map((entry) => `<div class="chart-row"><span class="chart-month">${monthName(entry.month)}</span><div class="chart-track"><div class="chart-bar" style="width:${Math.max(2, entry.revenue / highest * 100)}%"></div></div><strong class="chart-value">${money(entry.revenue)}</strong></div>`).join('')}</div>` : '<div class="empty-state">Grafik akan terbentuk setelah transaksi penjualan tercatat.</div>'}
      <p class="report-note" style="padding:0 19px 17px">Laba yang ditampilkan adalah laba kotor dan belum mengurangi biaya operasional usaha.</p></article>
    <article class="panel"><header class="panel-header"><h2>Piutang pelanggan</h2><span class="receivable-total">${money(outstanding.reduce((sum, sale) => sum + sale.remaining, 0))}</span></header>
      ${outstanding.length ? `<div class="table-wrap"><table><thead><tr><th>Pelanggan</th><th>Invoice</th><th>Sisa</th></tr></thead><tbody>${outstanding.map((sale) => `<tr><td>${escapeHtml(sale.customer)}<span class="secondary-line">${dateTime(sale.sold_at)}</span></td><td><button class="panel-link" data-action="sale-detail" data-id="${sale.id}">${escapeHtml(sale.invoice)}</button></td><td class="numeric">${money(sale.remaining)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">Tidak ada piutang yang berjalan.</div>'}</article></section>
    <section class="report-grid finance-grid"><article class="panel"><header class="panel-header"><h2>Neraca sederhana</h2><span class="muted">Posisi saat ini</span></header>
      <div class="finance-lines"><div><span>Kas dan bank</span><strong>${money(balance.cash)}</strong></div><div><span>Piutang usaha</span><strong>${money(balance.receivables)}</strong></div><div><span>Persediaan</span><strong>${money(balance.inventory)}</strong></div><div class="finance-total"><span>Total aset</span><strong>${money(balance.assets)}</strong></div><div><span>Liabilitas tercatat</span><strong>${money(balance.liabilities)}</strong></div><div><span>Modal pemilik</span><strong>${money(balance.capital)}</strong></div><div><span>Saldo laba / penyesuaian awal*</span><strong>${money(balance.retainedEarnings)}</strong></div></div></article>
      <article class="panel"><header class="panel-header"><h2>Arus kas ringkas</h2><span class="muted">Kas masuk dan keluar</span></header>
      <div class="finance-lines"><div><span>Penerimaan penjualan</span><strong>${money(cashFlow.salesReceipts)}</strong></div><div><span>Pendapatan lainnya</span><strong>${money(cashFlow.otherIncome)}</strong></div><div><span>Setoran modal</span><strong>${money(cashFlow.capital)}</strong></div><div><span>Penerimaan pinjaman</span><strong>${money(cashFlow.debtReceived)}</strong></div><div><span>Biaya dibayar</span><strong>− ${money(cashFlow.expenses)}</strong></div><div><span>Pembayaran kewajiban</span><strong>− ${money(cashFlow.debtPaid)}</strong></div><div class="finance-total"><span>Saldo kas terhitung</span><strong>${money(cashFlow.net)}</strong></div></div></article></section>
    <article class="panel table-panel finance-ledger"><header class="panel-header"><h2>Pencatatan kas, modal, dan biaya</h2><span class="muted">*Laporan manajerial; konsultasikan penyajian final dengan akuntan.</span></header>
      <div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Keterangan</th><th>Jenis</th><th>Nominal</th></tr></thead><tbody>${entryRows || '<tr><td colspan="4"><div class="empty-state">Belum ada kas masuk lain, modal, atau biaya yang dicatat.</div></td></tr>'}</tbody></table></div></article>
    <p class="report-note">*Laba bersih dihitung dari omzet, HPP, pendapatan lain, dan biaya yang dicatat. Nilai modal dan saldo awal aset usaha perlu dicatat untuk pelaporan akuntansi formal.</p>`;
}

function modal(title, subtitle, body) {
  dialog.innerHTML = `<header class="dialog-header"><div><h2>${title}</h2><p>${subtitle}</p></div><button class="icon-button" data-action="close-dialog" aria-label="Tutup">${icon('close')}</button></header>${body}`;
  dialog.showModal();
}

function openProductForm() {
  modal('Tambah barang', 'Daftarkan bahan produksi atau produk jadi Aster.', `<form id="product-form" class="dialog-body">
    <div class="form-grid"><div class="field field-full"><label for="product-name">Nama barang</label><input id="product-name" name="name" required maxlength="100" placeholder="Contoh: Kaos polos cotton combed"></div>
    <div class="field"><label for="product-sku">Kode SKU</label><input id="product-sku" name="sku" maxlength="32" placeholder="Otomatis bila dikosongkan"></div>
    <div class="field"><label for="product-barcode">Barcode</label><input id="product-barcode" name="barcode" maxlength="80" placeholder="Pindai atau ketik kode"></div>
    <div class="field"><label for="product-category">Kategori</label><input id="product-category" name="category" required maxlength="50" placeholder="Kaos, tas, sablon..."></div>
    <div class="field"><label for="product-kind">Jenis persediaan</label><select id="product-kind" name="kind"><option value="material">Bahan baku</option><option value="finished">Barang jadi</option></select></div>
    <div class="field"><label for="product-unit">Satuan</label><input id="product-unit" name="unit" required maxlength="20" value="pcs"></div>
    <div class="field"><label for="product-stock">Stok awal</label><input id="product-stock" name="stock" type="number" min="0" step="0.01" value="0" required></div>
    <div class="field"><label for="product-min">Batas minimum stok</label><input id="product-min" name="min_stock" type="number" min="0" step="0.01" value="0" required></div>
    <div class="field"><label for="product-cost">HPP per unit (Rp)</label><input id="product-cost" name="cost_price" type="number" min="0" step="500" value="0" required></div>
    <div class="field"><label for="product-price">Harga jual (Rp)</label><input id="product-price" name="sale_price" type="number" min="0" step="500" value="0" required></div></div>
    <div class="dialog-actions"><button type="button" class="button button-secondary" data-action="close-dialog">Batal</button><button class="button button-primary" type="submit">Simpan barang</button></div></form>`);
}

function openDeleteProductForm(id) {
  const product = state.products.find((item) => item.id === id);
  if (!product) throw new Error('Barang tidak ditemukan.');
  modal('Hapus persediaan', `${escapeHtml(product.name)} · stok ${quantity(product.stock)} ${escapeHtml(product.unit)}`, `<form id="delete-product-form" class="dialog-body" data-product-id="${product.id}">
    <div class="void-note">Barang akan disembunyikan dari persediaan dan pilihan transaksi. Riwayat penjualan/produksi tetap tersimpan agar laporan tidak rusak.</div>
    <div class="field"><label for="delete-product-reason">Alasan penghapusan</label><textarea id="delete-product-reason" name="reason" required maxlength="200" placeholder="Contoh: barang salah dicatat atau duplikat"></textarea></div>
    <div class="dialog-actions"><button type="button" class="button button-secondary" data-action="close-dialog">Batal</button><button class="button button-danger" type="submit">Hapus persediaan</button></div></form>`);
}

function openStockForm(id) {
  const product = state.products.find((item) => item.id === id);
  if (!product) return;
  modal('Sesuaikan stok', `${escapeHtml(product.name)} · saat ini ${quantity(product.stock)} ${escapeHtml(product.unit)}`, `<form id="stock-form" class="dialog-body" data-product-id="${product.id}">
    <div class="form-grid"><div class="field"><label for="stock-direction">Arah perubahan</label><select id="stock-direction" name="direction"><option value="add">Tambah stok</option><option value="subtract">Kurangi stok</option></select></div>
    <div class="field"><label for="stock-quantity">Jumlah (${escapeHtml(product.unit)})</label><input id="stock-quantity" name="quantity" type="number" min="0.01" step="0.01" required placeholder="0"></div>
    <div class="field field-full"><label for="stock-note">Catatan</label><input id="stock-note" name="note" required maxlength="120" placeholder="Contoh: Pembelian bahan, barang rusak"></div></div>
    <div class="dialog-actions"><button type="button" class="button button-secondary" data-action="close-dialog">Batal</button><button class="button button-primary" type="submit">Simpan perubahan</button></div></form>`);
}

function saleLineMarkup() {
  const available = state.products.filter((product) => product.stock > 0);
  const options = available.map((product) => `<option value="${product.id}" data-price="${product.sale_price}" data-stock="${product.stock}" data-unit="${escapeHtml(product.unit)}">${escapeHtml(product.name)} · sisa ${quantity(product.stock)} ${escapeHtml(product.unit)}</option>`).join('');
  return `<div class="sale-line"><div class="field"><label>Barang</label><select name="product_id" required ${available.length ? '' : 'disabled'}><option value="">${available.length ? 'Pilih barang' : 'Stok kosong'}</option>${options}</select></div>
    <div class="field"><label>Jumlah</label><input name="quantity" type="number" min="0.01" step="0.01" value="1" required></div>
    <div class="field"><label>Harga / unit</label><input name="unit_price" type="number" min="0" step="500" value="${available[0]?.sale_price || 0}" required></div>
    <button class="remove-line" type="button" data-action="remove-sale-line" aria-label="Hapus barang">${icon('close')}</button></div>`;
}

function productionLineMarkup() {
  const materials = state.products.filter((product) => product.kind === 'material' && product.stock > 0);
  const options = materials.map((product) => `<option value="${product.id}" data-stock="${product.stock}">${escapeHtml(product.name)} · sisa ${quantity(product.stock)} ${escapeHtml(product.unit)}</option>`).join('');
  return `<div class="sale-line production-line"><div class="field"><label>Bahan baku</label><select name="product_id" required ${materials.length ? '' : 'disabled'}>${options || '<option value="">Stok bahan kosong</option>'}</select></div>
    <div class="field"><label>Jumlah pakai</label><input name="quantity" type="number" min="0.01" step="0.01" value="1" required></div>
    <button class="remove-line" type="button" data-action="remove-production-line" aria-label="Hapus bahan">${icon('close')}</button></div>`;
}

function openProductionForm() {
  const outputProducts = state.products.filter((product) => product.kind === 'finished');
  const materials = state.products.some((product) => product.kind === 'material' && product.stock > 0);
  const outputs = outputProducts.map((product) => `<option value="${product.id}">${escapeHtml(product.name)}</option>`).join('');
  modal('Catat produksi', 'Stok bahan akan dipotong; barang jadi dan HPP/unit diperbarui secara atomik.', `<form id="production-form" class="dialog-body">
    <div class="form-grid"><div class="field field-full"><label for="production-output">Produk jadi</label><select id="production-output" name="output_product_id" required ${outputProducts.length ? '' : 'disabled'}>${outputs || '<option value="">Belum ada produk jadi</option>'}</select></div>
    <div class="field"><label for="production-quantity">Jumlah hasil</label><input id="production-quantity" name="output_quantity" type="number" min="0.01" step="0.01" required></div>
    <div class="field"><label for="production-labor">Biaya tenaga kerja (Rp)</label><input id="production-labor" name="labor_cost" type="number" min="0" step="1" value="0" required></div>
    <div class="field"><label for="production-overhead">Biaya overhead (Rp)</label><input id="production-overhead" name="overhead_cost" type="number" min="0" step="1" value="0" required></div>
    <div class="field"><label for="production-note">Catatan batch</label><input id="production-note" name="note" maxlength="200" placeholder="Opsional"></div></div>
    <section><div class="panel-header" style="padding:0 0 9px"><h2>Bahan yang digunakan</h2><button class="panel-link" type="button" data-action="add-production-line">${icon('plus')} Tambah bahan</button></div>
      <div id="production-lines" class="sale-lines">${materials ? productionLineMarkup() : '<div class="empty-state">Tambahkan stok bahan baku terlebih dahulu.</div>'}</div></section>
    <div class="dialog-actions"><button type="button" class="button button-secondary" data-action="close-dialog">Batal</button><button class="button button-primary" type="submit" ${outputProducts.length && materials ? '' : 'disabled'}>Simpan produksi</button></div></form>`);
}

function openFinancialEntryForm() {
  modal('Catat keuangan', 'Catat biaya, setoran modal, atau pendapatan lain untuk laporan.', `<form id="financial-form" class="dialog-body">
    <div class="form-grid"><div class="field"><label for="financial-type">Jenis pencatatan</label><select id="financial-type" name="entry_type"><option value="expense">Biaya usaha</option><option value="capital">Setoran modal</option><option value="income">Pendapatan lain</option><option value="debt">Penerimaan pinjaman / utang</option><option value="debt_payment">Pembayaran kewajiban</option></select></div>
    <div class="field"><label for="financial-amount">Nominal (Rp)</label><input id="financial-amount" name="amount" type="number" min="1" step="1" required></div>
    <div class="field field-full"><label for="financial-description">Keterangan</label><input id="financial-description" name="description" required maxlength="150" placeholder="Contoh: listrik workshop"></div>
    <div class="field"><label for="financial-date">Tanggal</label><input id="financial-date" name="entry_date" type="date" required value="${new Date().toISOString().slice(0, 10)}"></div></div>
    <div class="dialog-actions"><button type="button" class="button button-secondary" data-action="close-dialog">Batal</button><button class="button button-primary" type="submit">Simpan pencatatan</button></div></form>`);
}

function openSaleForm() {
  const hasStock = state.products.some((product) => product.stock > 0);
  modal('Catat penjualan', 'Stok akan berkurang dan HPP tercatat otomatis saat disimpan.', `<form id="sale-form" class="dialog-body">
    <div class="form-grid"><div class="field"><label for="sale-customer">Nama pelanggan</label><input id="sale-customer" name="customer" required maxlength="100" placeholder="Nama pelanggan / usaha"></div>
    <div class="field"><label for="sale-method">Metode pembayaran</label><select id="sale-method" name="payment_method"><option>Transfer</option><option>Tunai</option><option>QRIS</option><option>Lainnya</option></select></div>
    <div class="field field-full"><label for="sale-note">Catatan pesanan</label><input id="sale-note" name="note" maxlength="200" placeholder="Contoh: pesanan sablon desain khusus"></div></div>
    <div class="field"><label for="sale-barcode">Pindai barcode / SKU</label><input id="sale-barcode" type="text" autocomplete="off" placeholder="Arahkan scanner ke sini lalu tekan Enter"><small>Scanner USB/Bluetooth bertipe keyboard dapat langsung digunakan.</small></div>
    <div><div class="panel-header" style="padding:0 0 9px"><h2>Barang dipesan</h2><button class="panel-link" type="button" data-action="add-sale-line">${icon('plus')} Tambah barang</button></div><div id="sale-lines" class="sale-lines">${hasStock ? saleLineMarkup() : '<div class="empty-state">Belum ada stok yang dapat dijual. Tambahkan stok terlebih dahulu.</div>'}</div></div>
    <div class="sale-total"><span>Total pesanan</span><strong id="sale-total">${money(0)}</strong></div>
    <div class="form-grid"><div class="field field-full"><label for="sale-payment">Pembayaran diterima (Rp)</label><input id="sale-payment" name="initial_payment" type="number" min="0" step="1" value="0" required><small>Isi nominal DP atau pembayaran penuh. Kosongkan sebagai 0 untuk mencatat piutang.</small></div></div>
    <div class="dialog-actions"><button type="button" class="button button-secondary" data-action="close-dialog">Batal</button><button class="button button-primary" type="submit" ${hasStock ? '' : 'disabled'}>Simpan penjualan</button></div></form>`);
  updateSaleTotal();
}

function updateSaleTotal() {
  const lines = dialog.querySelectorAll('.sale-line');
  const total = [...lines].reduce((sum, line) => sum + (Number(line.querySelector('[name="quantity"]').value) || 0) * (Number(line.querySelector('[name="unit_price"]').value) || 0), 0);
  const target = dialog.querySelector('#sale-total');
  if (target) target.textContent = money(total);
}

async function openSaleDetail(idOrInvoice) {
  const sale = await api(`/api/sales/${encodeURIComponent(idOrInvoice)}`);
  const items = sale.items.map((item) => `<tr><td>${escapeHtml(item.product_name)}<span class="secondary-line">${quantity(item.quantity)} x ${money(item.unit_price)}</span></td><td class="numeric">${money(item.subtotal)}</td></tr>`).join('');
  const paymentHistory = sale.payments.length ? sale.payments.map((payment) => `<div class="stock-item"><span>${escapeHtml(payment.method)}<span class="secondary-line">${dateTime(payment.paid_at)}</span></span><strong class="numeric">${money(payment.amount)}</strong></div>`).join('') : '<div class="empty-state">Belum ada pembayaran tercatat.</div>';
  const paymentForm = sale.remaining > 0 && !sale.voided_at ? `<form id="payment-form" class="dialog-body" data-sale-id="${sale.id}"><div class="form-grid"><div class="field"><label for="payment-amount">Pembayaran berikutnya (Rp)</label><input id="payment-amount" name="amount" type="number" min="1" max="${sale.remaining}" step="1" required value="${sale.remaining}"></div><div class="field"><label for="payment-method">Metode</label><select id="payment-method" name="method"><option>Transfer</option><option>Tunai</option><option>QRIS</option><option>Lainnya</option></select></div></div><div class="dialog-actions"><button class="button button-primary" type="submit">Catat pembayaran</button></div></form>` : '';
  const voidSection = sale.voided_at ? `<p class="void-note">Penjualan dihapus dari perhitungan: ${escapeHtml(sale.void_reason || '')}</p>` : state.currentUser?.role === 'owner' ? `<form id="void-sale-form" class="dialog-body" data-sale-id="${sale.id}"><div class="void-note">Penjualan akan dihapus dari laporan dan stok barang dikembalikan. Riwayat koreksi tetap tersimpan.</div><div class="field"><label for="void-reason">Alasan penghapusan</label><input id="void-reason" name="reason" required maxlength="200" placeholder="Contoh: salah input atau transaksi duplikat"></div><div class="dialog-actions"><button class="button button-danger" type="submit">Hapus penjualan</button></div></form>` : '';
  modal(escapeHtml(sale.invoice), `${escapeHtml(sale.customer)} · ${dateTime(sale.sold_at)}`, `<div class="dialog-body"><div class="detail-facts"><div class="detail-fact"><span>Total pesanan</span><strong>${money(sale.total)}</strong></div><div class="detail-fact"><span>Status</span>${statusBadge(sale.status)}</div><div class="detail-fact"><span>Sudah dibayar</span><strong>${money(sale.paid)}</strong></div><div class="detail-fact"><span>Sisa tagihan</span><strong>${money(sale.remaining)}</strong></div></div>
    ${sale.note ? `<p class="muted" style="margin:0;font-size:10px">${escapeHtml(sale.note)}</p>` : ''}<section><div class="panel-header" style="padding:0 0 8px"><h2>Rincian barang</h2></div><div class="table-wrap"><table><tbody>${items}<tr><td><strong>HPP tercatat</strong><span class="secondary-line">Biaya barang saat penjualan</span></td><td class="numeric"><strong>${money(sale.cogs)}</strong></td></tr></tbody></table></div></section>
    <section><div class="panel-header" style="padding:0 0 8px"><h2>Riwayat pembayaran</h2></div><div class="panel">${paymentHistory}</div></section></div>${paymentForm}${voidSection}`);
}

function notify(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' is-error' : ''}`;
  toast.textContent = message;
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

async function submitForm(form) {
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    if (form.id === 'product-form') {
      const values = Object.fromEntries(new FormData(form));
      for (const key of ['stock', 'min_stock', 'cost_price', 'sale_price']) values[key] = Number(values[key]);
      await api('/api/products', { method: 'POST', body: JSON.stringify(values) });
      notify('Barang berhasil ditambahkan.');
      state.view = 'inventory';
      state.search = '';
    } else if (form.id === 'stock-form') {
      const values = Object.fromEntries(new FormData(form));
      const adjustment = Number(values.quantity) * (values.direction === 'subtract' ? -1 : 1);
      await api('/api/stock-adjustments', { method: 'POST', body: JSON.stringify({ product_id: Number(form.dataset.productId), quantity_delta: adjustment, note: values.note }) });
      notify('Perubahan stok berhasil dicatat.');
      state.view = 'inventory';
    } else if (form.id === 'sale-form') {
      const lines = [...form.querySelectorAll('.sale-line')].map((line) => ({
        product_id: Number(line.querySelector('[name="product_id"]').value),
        quantity: Number(line.querySelector('[name="quantity"]').value),
        unit_price: Number(line.querySelector('[name="unit_price"]').value),
      }));
      const values = Object.fromEntries(new FormData(form));
      await api('/api/sales', { method: 'POST', body: JSON.stringify({ customer: values.customer, note: values.note, items: lines, initial_payment: Number(values.initial_payment), payment_method: values.payment_method }) });
      notify('Penjualan tersimpan; stok dan HPP telah diperbarui.');
      state.view = 'sales';
    } else if (form.id === 'payment-form') {
      const values = Object.fromEntries(new FormData(form));
      await api(`/api/sales/${form.dataset.saleId}/payments`, { method: 'POST', body: JSON.stringify({ amount: Number(values.amount), method: values.method }) });
      notify('Pembayaran berhasil dicatat.');
      await refreshData();
      await openSaleDetail(form.dataset.saleId);
      return;
    } else if (form.id === 'production-form') {
      const values = Object.fromEntries(new FormData(form));
      const inputs = [...form.querySelectorAll('.production-line')].map((line) => ({
        product_id: Number(line.querySelector('[name="product_id"]').value),
        quantity: Number(line.querySelector('[name="quantity"]').value),
      }));
      await api('/api/production', { method: 'POST', body: JSON.stringify({
        output_product_id: Number(values.output_product_id), output_quantity: Number(values.output_quantity),
        labor_cost: Number(values.labor_cost), overhead_cost: Number(values.overhead_cost), note: values.note, inputs,
      }) });
      notify('Produksi tersimpan; stok bahan dan HPP barang jadi telah diperbarui.');
      state.view = 'production';
    } else if (form.id === 'financial-form') {
      const values = Object.fromEntries(new FormData(form));
      await api('/api/financial-entries', { method: 'POST', body: JSON.stringify({ ...values, amount: Number(values.amount) }) });
      notify('Pencatatan keuangan berhasil disimpan.');
      state.view = 'reports';
    } else if (form.id === 'delete-product-form') {
      const values = Object.fromEntries(new FormData(form));
      await api(`/api/products/${form.dataset.productId}`, { method: 'DELETE', body: JSON.stringify({ reason: values.reason }) });
      notify('Persediaan dihapus dari daftar; riwayat terkait tetap tersimpan.');
      state.view = 'inventory';
    } else if (form.id === 'void-sale-form') {
      const values = Object.fromEntries(new FormData(form));
      await api(`/api/sales/${form.dataset.saleId}/void`, { method: 'POST', body: JSON.stringify({ reason: values.reason }) });
      notify('Penjualan dihapus dari perhitungan; stok dikembalikan dan riwayat koreksi tetap tersimpan.');
      state.view = 'sales';
    }
    dialog.close();
    await refreshData();
  } catch (error) {
    notify(error.message, true);
    submitButton.disabled = false;
  }
}

document.addEventListener('click', async (event) => {
  const nav = event.target.closest('[data-view]');
  if (nav) return setView(nav.dataset.view);
  const filter = event.target.closest('[data-filter]');
  if (filter) {
    state.filter = filter.dataset.filter;
    return render();
  }
  const action = event.target.closest('[data-action]');
  if (!action) return;
  try {
    switch (action.dataset.action) {
      case 'create-product': openProductForm(); break;
      case 'delete-product': openDeleteProductForm(Number(action.dataset.id)); break;
      case 'create-sale': openSaleForm(); break;
      case 'create-production': openProductionForm(); break;
      case 'create-financial-entry': openFinancialEntryForm(); break;
      case 'update-stock': openStockForm(Number(action.dataset.id)); break;
      case 'view-sales': setView('sales'); break;
      case 'view-inventory': setView('inventory'); break;
      case 'sale-detail': await openSaleDetail(action.dataset.id); break;
      case 'close-dialog': dialog.close(); break;
      case 'add-sale-line': document.getElementById('sale-lines').insertAdjacentHTML('beforeend', saleLineMarkup()); break;
      case 'add-production-line': document.getElementById('production-lines').insertAdjacentHTML('beforeend', productionLineMarkup()); break;
      case 'remove-production-line':
        if (dialog.querySelectorAll('.production-line').length > 1) action.closest('.production-line').remove();
        break;
      case 'remove-sale-line':
        if (dialog.querySelectorAll('.sale-line').length > 1) action.closest('.sale-line').remove();
        updateSaleTotal();
        break;
      case 'retry': await refreshData(); break;
    }
  } catch (error) {
    notify(error.message, true);
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('#product-form, #delete-product-form, #stock-form, #sale-form, #payment-form, #production-form, #financial-form, #void-sale-form');
  if (!form) return;
  event.preventDefault();
  submitForm(form);
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'product-search') {
    state.search = event.target.value;
    const start = event.target.selectionStart;
    render();
    const replacement = document.getElementById('product-search');
    replacement.focus();
    replacement.setSelectionRange(start, start);
  }
  if (event.target.closest('#sale-form')) updateSaleTotal();
});

document.addEventListener('change', (event) => {
  if (event.target.matches('.sale-line select[name="product_id"]')) {
    const option = event.target.selectedOptions[0];
    event.target.closest('.sale-line').querySelector('[name="unit_price"]').value = option?.dataset.price || 0;
    updateSaleTotal();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.target.id !== 'sale-barcode' || event.key !== 'Enter') return;
  event.preventDefault();
  const code = event.target.value.trim().toLocaleLowerCase('id');
  if (!code) return;
  const product = state.products.find((item) => [item.barcode, item.sku].some((value) => String(value || '').toLocaleLowerCase('id') === code));
  if (!product) {
    notify('Barcode atau SKU tidak ditemukan.', true);
    event.target.select();
    return;
  }
  if (product.stock <= 0) {
    notify(`Stok ${product.name} sedang kosong.`, true);
    event.target.select();
    return;
  }
  const existing = [...dialog.querySelectorAll('.sale-line')].find((line) => Number(line.querySelector('[name="product_id"]').value) === product.id);
  if (existing) {
    const quantityInput = existing.querySelector('[name="quantity"]');
    const nextQuantity = Number(quantityInput.value) + 1;
    if (nextQuantity > product.stock) {
      notify(`Stok ${product.name} tidak mencukupi.`, true);
      return;
    }
    quantityInput.value = nextQuantity;
  } else {
    const emptyLine = [...dialog.querySelectorAll('.sale-line')].find((line) => !line.querySelector('[name="product_id"]').value);
    if (!emptyLine) document.getElementById('sale-lines').insertAdjacentHTML('beforeend', saleLineMarkup());
    const line = emptyLine || dialog.querySelector('.sale-line:last-child');
    line.querySelector('[name="product_id"]').value = String(product.id);
    line.querySelector('[name="unit_price"]').value = product.sale_price;
  }
  event.target.value = '';
  event.target.focus();
  updateSaleTotal();
});

dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

document.getElementById('today-label').textContent = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
initializeSupabaseApp();