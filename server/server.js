/* ============================================================
   Busterz World — checkout + admin backend

   A real PayPal integration needs a server, for two reasons the
   browser can't satisfy on its own:

     1. The PayPal *secret* must stay private. It lives only here,
        in an environment variable, and is used to get an OAuth
        token. It is never sent to the page.

     2. The amount to charge must be decided by someone the buyer
        can't edit. This server recomputes the order total from its
        OWN copy of the catalogue and pricing rules, so a tampered
        cart in the browser can't change what PayPal charges.

   The product catalogue lives in MongoDB (seeded once from the
   original data.js). The storefront still loads /assets/js/data.js,
   but the server now GENERATES that file from the database, so the
   admin can add/edit/price products and shoppers see the change on
   reload — with no front-end rewrite.

   Captured orders are persisted to MongoDB Atlas too, so an order
   survives even though the browser's localStorage is per-device.

   Public endpoints:
     GET  /api/config                 -> { clientId, currency }
     POST /api/orders                 -> create a PayPal order from the cart
     POST /api/orders/:id/capture     -> capture, save to Mongo, return order
     GET  /assets/js/data.js          -> catalogue as JS (generated from DB)

   Admin endpoints (require a Bearer token from /api/admin/login):
     POST   /api/admin/login
     GET    /api/admin/stats
     GET    /api/admin/products
     POST   /api/admin/products
     PUT    /api/admin/products/:id
     DELETE /api/admin/products/:id
     GET    /api/admin/orders

   Everything else is the static site in ../my codes.
   ============================================================ */

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomInt, createHmac, timingSafeEqual } from "node:crypto";
import { MongoClient } from "mongodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/* The original catalogue file is the SEED for the database and the
   fallback when MongoDB isn't configured. */
const SEED = require("../my codes/assets/js/data.js"); // { DEPARTMENTS, DEPT_ICONS, PRODUCTS }

/* In-memory copy of the live catalogue. It's the authoritative source
   for order pricing and for the generated data.js. loadCatalog() keeps
   it in sync with the database; admin writes refresh it. */
let catalog = SEED.PRODUCTS.slice();

/* These MUST stay in sync with the constants at the top of
   my codes/assets/js/app.js — the pricing rules the cart page and
   checkout summary use, mirrored so server and browser agree. */
const FREE_SHIP_OVER = 3500; // $35.00 — free shipping at or above this
const SHIP_FEE = 599; //        $5.99  — flat shipping otherwise
const TAX_RATE = 0.0875; //     8.75%  — sales tax

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV = "sandbox",
  CURRENCY = "USD",
  MONGODB_URI = "",
  MONGODB_DB = "busterzworld",
  ADMIN_USER = "admin",
  ADMIN_PASSWORD = "",
  ADMIN_SECRET = "",
  PORT = 3000,
} = process.env;

const PAYPAL_BASE =
  PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

/* Secret used to sign admin session tokens. Prefer a dedicated value;
   fall back to the PayPal secret so tokens still can't be forged if the
   admin one is unset, and finally a dev placeholder. */
const SIGNING_SECRET =
  ADMIN_SECRET || PAYPAL_CLIENT_SECRET || "busterz-dev-secret-change-me";

const app = express();
app.use(express.json());

/* ---------------------------------------------- MongoDB Atlas

   Connect lazily and reuse one client for the whole process. If no
   MONGODB_URI is set, the store runs from the seed file and admin
   writes are disabled (payments still work). */
let mongoPromise = null;

async function mongoDb() {
  if (!MONGODB_URI) return null;
  if (!mongoPromise) {
    mongoPromise = new MongoClient(MONGODB_URI).connect().catch((err) => {
      mongoPromise = null; // let the next call retry
      throw err;
    });
  }
  return (await mongoPromise).db(MONGODB_DB);
}

async function ordersCollection() {
  const db = await mongoDb();
  return db ? db.collection("orders") : null;
}

async function productsCollection() {
  const db = await mongoDb();
  return db ? db.collection("products") : null;
}

const stripId = ({ _id, ...rest }) => rest;

/* Load the catalogue into memory. Seeds the DB from the file on first
   run. Falls back to the file if MongoDB is down, so the store never
   breaks over a database hiccup. */
async function loadCatalog() {
  try {
    const col = await productsCollection();
    if (!col) {
      catalog = SEED.PRODUCTS.slice();
      return;
    }
    if ((await col.countDocuments()) === 0) {
      await col.insertMany(SEED.PRODUCTS.map((p) => ({ _id: p.id, ...p })));
      console.log(`Seeded ${SEED.PRODUCTS.length} products into MongoDB.`);
    }
    catalog = (await col.find().toArray()).map(stripId);
  } catch (err) {
    console.error("loadCatalog failed, using seed file:", err.message);
    catalog = SEED.PRODUCTS.slice();
  }
}

/* Persist a captured order. This runs AFTER PayPal has taken the money,
   so a database problem must never throw back to the buyer — we log it
   loudly and still return their confirmation. */
async function saveOrder(order, paypalDetails) {
  try {
    const col = await ordersCollection();
    if (!col) return false;
    await col.insertOne({ _id: order.id, ...order, _paypal: paypalDetails });
    return true;
  } catch (err) {
    console.error(
      "!! ORDER CAPTURED BUT NOT SAVED — reconcile manually:",
      order.id,
      order.payment && order.payment.captureId,
      err.message
    );
    return false;
  }
}

/* ---------------------------------------------- pricing */

const byId = (id) => catalog.find((p) => p.id === id) || null;

/* Recompute the totals from the cart the browser sent, trusting only
   the product ids and quantities — never a client-sent price. Unknown
   ids are dropped and quantities are clamped to what's in stock. */
function computeTotals(cart) {
  const lines = (Array.isArray(cart) ? cart : [])
    .map((l) => {
      const p = byId(l && l.id);
      if (!p) return null;
      const qty = Math.max(1, Math.min(Number(l.qty) || 0, p.stock));
      return { p, qty };
    })
    .filter(Boolean);

  const subtotal = lines.reduce((sum, x) => sum + x.p.price * x.qty, 0);
  const shipping = subtotal === 0 || subtotal >= FREE_SHIP_OVER ? 0 : SHIP_FEE;
  const tax = Math.round(subtotal * TAX_RATE);
  const total = subtotal + shipping + tax;
  return { subtotal, shipping, tax, total, lines };
}

/* PayPal wants decimal strings ("12.99"); our prices are integer cents. */
const money = (cents) => (cents / 100).toFixed(2);

/* Same human-readable id shape the browser used (see app.js Orders.newId),
   generated here so the server owns the canonical order id. */
function newOrderId() {
  const a = String(randomInt(0, 4294967295) % 10000000).padStart(7, "0");
  const b = String(Date.now() % 10000000).padStart(7, "0");
  return `114-${a}-${b}`;
}

/* Keep only the address fields we expect, coerced to short strings. */
function cleanAddress(a) {
  const s = (v) => String(v == null ? "" : v).slice(0, 120);
  a = a && typeof a === "object" ? a : {};
  return {
    name: s(a.name),
    line1: s(a.line1),
    line2: s(a.line2),
    city: s(a.city),
    state: s(a.state),
    zip: s(a.zip),
    phone: s(a.phone),
  };
}

function buildOrder(body, details) {
  const t = computeTotals(body && body.cart);
  const unit = details.purchase_units && details.purchase_units[0];
  const capture =
    unit && unit.payments && unit.payments.captures && unit.payments.captures[0];
  const payer = details.payer || {};
  const payerName = payer.name
    ? [payer.name.given_name, payer.name.surname].filter(Boolean).join(" ")
    : "";

  return {
    id: newOrderId(),
    email: (body && body.email) || payer.email_address || "",
    placedAt: new Date().toISOString(),
    deliveryBy: String((body && body.deliveryBy) || "").slice(0, 60),
    items: t.lines.map((x) => ({
      id: x.p.id,
      title: x.p.title,
      glyph: x.p.glyph,
      tint: x.p.tint,
      price: x.p.price,
      qty: x.qty,
    })),
    totals: { subtotal: t.subtotal, shipping: t.shipping, tax: t.tax, total: t.total },
    address: cleanAddress(body && body.address),
    payment: {
      method: "PayPal",
      brand: "PayPal",
      glyph: "PayPal",
      last4: String((capture && capture.id) || details.id || "").slice(-4),
      name: payer.email_address || payerName || "PayPal account",
      captureId: (capture && capture.id) || null,
      paypalOrderId: details.id || null,
      amount: (capture && capture.amount) || null,
    },
  };
}

/* ---------------------------------------------- product normalization */

/* Coerce whatever the admin form sent into a clean product record.
   Prices arrive as integer cents. `existing` preserves the id on edit. */
function normalizeProduct(input, existing) {
  input = input && typeof input === "object" ? input : {};
  const str = (v, n = 200) => String(v == null ? "" : v).slice(0, n);
  const cents = (v) => Math.max(0, Math.round(Number(v) || 0));
  const dept = SEED.DEPARTMENTS.includes(input.dept)
    ? input.dept
    : existing
    ? existing.dept
    : SEED.DEPARTMENTS[0];

  const p = {
    id: existing ? existing.id : genProductId(dept),
    title: str(input.title, 200) || "Untitled product",
    brand: str(input.brand, 80),
    dept,
    price: cents(input.price),
    rating: Math.min(5, Math.max(0, Number(input.rating) || 0)),
    reviews: cents(input.reviews),
    prime: !!input.prime,
    stock: cents(input.stock),
    glyph: str(input.glyph, 8) || "📦",
    tint: /^#[0-9a-fA-F]{6}$/.test(input.tint) ? input.tint : "#eef2f6",
    desc: str(input.desc, 1000),
    features: Array.isArray(input.features)
      ? input.features.map((f) => str(f, 200)).filter(Boolean).slice(0, 12)
      : [],
  };
  const listPrice = cents(input.listPrice);
  if (listPrice > 0) p.listPrice = listPrice;
  if (input.isNew) p.isNew = true;
  return p;
}

function genProductId(dept) {
  const prefix = (dept[0] || "x").toLowerCase();
  return `${prefix}${randomInt(100000, 999999)}`;
}

/* ---------------------------------------------- admin auth */

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", SIGNING_SECRET).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expect = createHmac("sha256", SIGNING_SECRET).update(body).digest("base64url");
  if (!safeEqual(mac, expect)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = verifyToken(token);
  if (!payload || payload.role !== "admin") {
    return res.status(401).json({ error: "Not authorized — please sign in again." });
  }
  req.admin = payload;
  next();
}

async function requireMongo(res) {
  const col = await productsCollection();
  if (!col) {
    res
      .status(400)
      .json({ error: "MongoDB is required for the admin. Set MONGODB_URI in .env." });
    return null;
  }
  return col;
}

/* ---------------------------------------------- public API */

app.get("/api/config", (_req, res) => {
  /* The client id is public — safe to hand to the browser so the PayPal
     SDK can load. The secret stays server-side. */
  res.json({ clientId: PAYPAL_CLIENT_ID || "", currency: CURRENCY });
});

/* The storefront's catalogue, generated from the live database. Same
   globals the original file defined, so no page needs to change. */
app.get("/assets/js/data.js", (_req, res) => {
  const js =
    "/* Generated from the database by the server. Edit products in /admin. */\n" +
    `const DEPARTMENTS = ${JSON.stringify(SEED.DEPARTMENTS)};\n` +
    `const DEPT_ICONS = ${JSON.stringify(SEED.DEPT_ICONS)};\n` +
    `const PRODUCTS = ${JSON.stringify(catalog)};\n` +
    'if (typeof module !== "undefined" && module.exports) {\n' +
    "  module.exports = { DEPARTMENTS, DEPT_ICONS, PRODUCTS };\n" +
    "}\n";
  res.set("Cache-Control", "no-store");
  res.type("application/javascript").send(js);
});

app.post("/api/orders", async (req, res) => {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    return res.status(500).json({
      error:
        "PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.",
    });
  }
  try {
    const t = computeTotals(req.body && req.body.cart);
    if (t.total <= 0) return res.status(400).json({ error: "Your cart is empty." });

    const token = await accessToken();
    const order = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: CURRENCY,
            value: money(t.total),
            breakdown: {
              item_total: { currency_code: CURRENCY, value: money(t.subtotal) },
              shipping: { currency_code: CURRENCY, value: money(t.shipping) },
              tax_total: { currency_code: CURRENCY, value: money(t.tax) },
            },
          },
          items: t.lines.map((x) => ({
            name: x.p.title.slice(0, 127),
            quantity: String(x.qty),
            unit_amount: { currency_code: CURRENCY, value: money(x.p.price) },
            category: "PHYSICAL_GOODS",
          })),
        },
      ],
    };

    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(order),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json({ id: data.id });
  } catch (err) {
    console.error("create order:", err);
    res.status(500).json({ error: "Could not create the PayPal order." });
  }
});

app.post("/api/orders/:id/capture", async (req, res) => {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    return res.status(500).json({ error: "PayPal is not configured." });
  }
  try {
    const token = await accessToken();
    const r = await fetch(
      `${PAYPAL_BASE}/v2/checkout/orders/${encodeURIComponent(
        req.params.id
      )}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    const details = await r.json();
    if (!r.ok) return res.status(r.status).json(details);
    if (details.status !== "COMPLETED") {
      return res.json({ status: details.status, order: null });
    }
    const order = buildOrder(req.body, details);
    const saved = await saveOrder(order, details);
    res.json({ status: "COMPLETED", saved, order });
  } catch (err) {
    console.error("capture order:", err);
    res.status(500).json({ error: "Could not capture the PayPal order." });
  }
});

async function accessToken() {
  const auth = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
  ).toString("base64");
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new Error(`PayPal auth failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()).access_token;
}

/* ---------------------------------------------- admin API */

app.post("/api/admin/login", (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({
      error: "Admin is not configured. Set ADMIN_PASSWORD in server/.env and restart.",
    });
  }
  const { username, password } = req.body || {};
  const ok =
    safeEqual(username || "", ADMIN_USER) && safeEqual(password || "", ADMIN_PASSWORD);
  if (!ok) return res.status(401).json({ error: "Wrong username or password." });
  const token = signToken({
    role: "admin",
    user: ADMIN_USER,
    exp: Date.now() + 12 * 60 * 60 * 1000, // 12 hours
  });
  res.json({ token, user: ADMIN_USER });
});

app.get("/api/admin/stats", requireAdmin, async (_req, res) => {
  let orders = [];
  const col = await ordersCollection();
  if (col) orders = await col.find().toArray();
  const revenueCents = orders.reduce((s, o) => s + ((o.totals && o.totals.total) || 0), 0);
  const recent = orders
    .slice()
    .sort((a, b) => (a.placedAt < b.placedAt ? 1 : -1))
    .slice(0, 6);
  res.json({
    products: catalog.length,
    orders: orders.length,
    revenueCents,
    lowStock: catalog.filter((p) => p.stock <= 5).length,
    outOfStock: catalog.filter((p) => p.stock === 0).length,
    recent,
    paypalEnv: PAYPAL_ENV,
    mongo: !!col,
  });
});

app.get("/api/admin/products", requireAdmin, (_req, res) => {
  res.json({ products: catalog, departments: SEED.DEPARTMENTS });
});

app.post("/api/admin/products", requireAdmin, async (req, res) => {
  const col = await requireMongo(res);
  if (!col) return;
  const product = normalizeProduct(req.body, null);
  await col.insertOne({ _id: product.id, ...product });
  await loadCatalog();
  res.json({ product });
});

app.put("/api/admin/products/:id", requireAdmin, async (req, res) => {
  const col = await requireMongo(res);
  if (!col) return;
  const existing = catalog.find((p) => p.id === req.params.id);
  if (!existing) return res.status(404).json({ error: "Product not found." });
  const product = normalizeProduct(req.body, existing);
  await col.replaceOne({ _id: product.id }, { _id: product.id, ...product });
  await loadCatalog();
  res.json({ product });
});

app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  const col = await requireMongo(res);
  if (!col) return;
  await col.deleteOne({ _id: req.params.id });
  await loadCatalog();
  res.json({ ok: true });
});

app.get("/api/admin/orders", requireAdmin, async (_req, res) => {
  const col = await ordersCollection();
  if (!col) return res.json({ orders: [] });
  const orders = await col.find().sort({ placedAt: -1 }).limit(200).toArray();
  res.json({ orders });
});

/* ---------------------------------------------- static site */

app.use(express.static(path.join(__dirname, "..", "my codes")));

/* Only bind a port when run directly (node server.js). When imported by
   a test, the routes and helpers are available without starting a server. */
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  await loadCatalog();
  app.listen(PORT, () => {
    console.log(`Busterz World running:  http://localhost:${PORT}`);
    console.log(`Admin dashboard:        http://localhost:${PORT}/admin/`);
    console.log(`PayPal environment:     ${PAYPAL_ENV.toUpperCase()}`);
    console.log(
      `Order storage:          ${
        MONGODB_URI ? "MongoDB Atlas (" + MONGODB_DB + ")" : "OFF — set MONGODB_URI to persist"
      }`
    );
    console.log(`Catalogue:              ${catalog.length} products`);
    if (PAYPAL_ENV === "live") console.log("  (!) LIVE mode — real payments will be charged.");
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET)
      console.log("  (!) No PayPal credentials yet — set them in .env.");
    if (!ADMIN_PASSWORD)
      console.log("  (!) Admin login disabled — set ADMIN_PASSWORD in .env.");
  });
}

export { app, computeTotals, buildOrder, newOrderId, cleanAddress, normalizeProduct, signToken, verifyToken };
