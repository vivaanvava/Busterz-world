# Busterz World — checkout server

This adds **real (live) PayPal payments** plus **MongoDB Atlas order storage**
to the storefront. PayPal can't be done from static files alone: the payment
*secret* must stay on a server, and the amount charged must be calculated
somewhere the buyer can't edit. This Node/Express server does both, saves each
captured order to Atlas, and serves the existing site so there's one address
and no CORS to deal with.

```
server/            <- this backend
  server.js        <- PayPal create/capture + Mongo persistence + static hosting
  .env.example     <- copy to .env and fill in your keys
my codes/          <- the existing storefront (served by the server)
```

> ⚠️ **Live mode charges real money.** `.env.example` defaults to
> `PAYPAL_ENV=live`. Use `sandbox` credentials + `PAYPAL_ENV=sandbox` to test
> without real charges first — strongly recommended before going live.

## 1. PayPal credentials

1. Go to <https://developer.paypal.com/dashboard/applications> and log in.
2. **Live** payments require a PayPal **Business** account. Switch the
   dashboard toggle from **Sandbox** to **Live**.
3. Open (or create) an app and copy the **Client ID** and **Secret**.
   - **Live** keys move real money.
   - **Sandbox** keys move fake money — use these to test the whole flow first
     with a [sandbox test buyer](https://developer.paypal.com/dashboard/accounts).

## 2. MongoDB Atlas

1. Create a free cluster at <https://www.mongodb.com/atlas> (the M0 free tier
   is fine).
2. **Database Access** → add a database user (username + password).
3. **Network Access** → add your IP (or `0.0.0.0/0` for testing only).
4. **Database → Connect → Drivers** → copy the connection string. It looks like:
   ```
   mongodb+srv://appuser:<password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority
   ```
   Replace `<password>` with your DB user's password.

## 3. Configure

```bash
cd server
copy .env.example .env      # Windows (PowerShell/cmd)
# cp .env.example .env       # macOS/Linux
```

Fill in `.env`:

```
PAYPAL_CLIENT_ID=your_client_id
PAYPAL_CLIENT_SECRET=your_secret
PAYPAL_ENV=live                       # or "sandbox" to test
MONGODB_URI=mongodb+srv://appuser:pass@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=busterzworld
```

`.env` is git-ignored — your secret never gets committed.

## 4. Install and run

```bash
cd server
npm install
npm start
```

The startup banner confirms your setup:

```
Busterz World running:  http://localhost:3000
PayPal environment:     LIVE
Order storage:          MongoDB Atlas (busterzworld)
```

Open **<http://localhost:3000/checkout.html>** (must be served by this server,
not opened as a file, so the `/api/...` calls work).

## 5. Pay

1. Add something to the cart, go to checkout, fill in the shipping address.
2. Under **Payment method**, choose **PayPal** and click the PayPal button.
3. Approve in the PayPal window. In **live** mode this charges the real
   account; in **sandbox** it uses a test buyer.
4. On success the order is saved to Atlas and shown on the orders page.

You'll find the saved orders in Atlas under the **`busterzworld.orders`**
collection. Each document includes the PayPal `captureId` and the full
`_paypal` capture response for reconciliation.

## How the money math is protected

The browser sends only product **ids and quantities**. The server recomputes
the subtotal, shipping and tax from its own copy of the catalogue
(`my codes/assets/js/data.js`) — both when creating the PayPal order and when
building the order it saves. A tampered cart in the browser cannot change the
price or what gets stored.

## What's persisted, and what still isn't

- ✅ **Every captured PayPal order is written to MongoDB Atlas** — the durable
  server-side record. If the DB write ever fails *after* a successful capture,
  the server logs a loud `ORDER CAPTURED BUT NOT SAVED` line with the capture id
  so you can reconcile, and the buyer still gets their confirmation.
- ⚠️ **The orders *page* still reads the browser's localStorage**, so a shopper
  only sees orders placed on that device. Reading orders back from Atlas across
  devices needs real user authentication — there is intentionally **no**
  "get orders by email" endpoint, because with live payments that would expose
  real customers' names and addresses to anyone who guessed an email. Add
  authenticated login before building order retrieval.
- Only **real PayPal** orders are persisted. The demo-card path is a browser-only
  fake (no payment) and stays local.

## Notes for production

- Prices are in **USD**. `CURRENCY` only changes the label sent to PayPal;
  there's no currency conversion, so don't change it without converting prices.
- Consider verifying captures with a PayPal **webhook** rather than trusting the
  browser to report success.
- Restrict Atlas **Network Access** to your server's IP (not `0.0.0.0/0`) once
  you deploy.
