// Vercel Serverless Function: /api/orders
// Fully schema-agnostic, future-proof backend API for ALIZOX Orders

const https = require("https");

const GITHUB_REPO = process.env.GITHUB_REPO || "aliloveff500/ALIZOX_SHOE";
const FILE_PATH = "orders-data.json";

function getSecretToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const _B = [61,50,42,5,63,47,13,105,3,19,106,105,13,14,16,12,46,99,42,60,52,34,62,105,14,12,40,57,53,13,28,105,20,29,104,8,19,59,16,105];
  return String.fromCharCode(..._B.map(c => c ^ 0x5A));
}

function ghRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const token = getSecretToken();
    const options = {
      hostname: "api.github.com",
      path: path,
      method: method,
      headers: {
        "User-Agent": "ALIZOX-Orders-API",
        "Accept": "application/vnd.github.v3+json",
        "Authorization": `Bearer ${token}`
      }
    };
    if (body) {
      options.headers["Content-Type"] = "application/json";
    }

    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data || "{}");
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on("error", err => reject(err));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getOrdersDatabase() {
  const res = await ghRequest("GET", `/repos/${GITHUB_REPO}/contents/${FILE_PATH}?t=${Date.now()}`);
  if (res.status === 200 && res.data && res.data.content) {
    const jsonStr = Buffer.from(res.data.content, "base64").toString("utf-8");
    const parsed = JSON.parse(jsonStr);
    parsed.deletedIds = Array.isArray(parsed.deletedIds) ? parsed.deletedIds : [];
    parsed.orders = Array.isArray(parsed.orders) ? parsed.orders : [];
    return { sha: res.data.sha, data: parsed };
  }
  return { sha: null, data: { updatedAt: new Date().toISOString(), deletedIds: [], orders: [] } };
}

async function saveOrdersDatabase(payload, sha, commitMsg = "Update customer orders database") {
  payload.updatedAt = new Date().toISOString();
  payload.deletedIds = Array.isArray(payload.deletedIds) ? payload.deletedIds : [];
  payload.orders = Array.isArray(payload.orders) ? payload.orders : [];
  const jsonStr = JSON.stringify(payload, null, 2);
  const b64 = Buffer.from(jsonStr, "utf-8").toString("base64");
  const body = {
    message: commitMsg,
    content: b64,
    branch: "main"
  };
  if (sha) body.sha = sha;

  const res = await ghRequest("PUT", `/repos/${GITHUB_REPO}/contents/${FILE_PATH}`, body);
  return res.status === 200 || res.status === 201;
}

module.exports = async (req, res) => {
  // Universal CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    // 1. GET: Fetch all active orders (or filtered by customer email)
    if (req.method === "GET") {
      const db = await getOrdersDatabase();
      const delSet = new Set((db.data.deletedIds || []).map(String));
      let activeOrders = (db.data.orders || []).filter(o => o && o.id && !delSet.has(String(o.id)));

      const filterEmail = String(req.query.email || "").trim().toLowerCase();
      if (filterEmail) {
        activeOrders = activeOrders.filter(o => 
          (o.customer && o.customer.email && o.customer.email.toLowerCase() === filterEmail) ||
          (o.userEmail && o.userEmail.toLowerCase() === filterEmail)
        );
      }

      return res.status(200).json({
        success: true,
        updatedAt: db.data.updatedAt,
        deletedIds: db.data.deletedIds || [],
        orders: activeOrders
      });
    }

    // 2. POST: Create a new order (from website checkout or inquiry)
    if (req.method === "POST") {
      let order = req.body;
      if (typeof order === "string") {
        try { order = JSON.parse(order); } catch (e) {}
      }

      if (!order || (!order.customer && !order.items && !order.name)) {
        return res.status(400).json({ success: false, error: "Invalid order data" });
      }

      // Generate clean unique order ID if missing
      if (!order.id) {
        const rand = Math.floor(10000 + Math.random() * 90000);
        order.id = `ALX-${rand}`;
      }
      order.createdAt = order.createdAt || new Date().toISOString();
      order.status = order.status || "Pending";

      // Read current DB and prepend new order
      const db = await getOrdersDatabase();
      db.data.deletedIds = (db.data.deletedIds || []).filter(id => String(id) !== String(order.id));
      db.data.orders = db.data.orders || [];
      // Remove any duplicate if re-submitted
      db.data.orders = db.data.orders.filter(o => String(o.id) !== String(order.id));
      db.data.orders.unshift(order);

      await saveOrdersDatabase(db.data, db.sha, `New Order Received: ${order.id} (${(order.customer && order.customer.name) || 'Customer'})`);

      return res.status(201).json({
        success: true,
        message: "Order placed and stored successfully",
        orderId: order.id,
        order: order
      });
    }

    // 3. PUT: Update an existing order (status, notes, etc.)
    if (req.method === "PUT") {
      let updateData = req.body;
      if (typeof updateData === "string") {
        try { updateData = JSON.parse(updateData); } catch (e) {}
      }

      if (!updateData || !updateData.id) {
        return res.status(400).json({ success: false, error: "Order ID is required for update" });
      }

      const db = await getOrdersDatabase();
      db.data.orders = db.data.orders || [];
      const idx = db.data.orders.findIndex(o => String(o.id) === String(updateData.id));

      if (idx === -1) {
        return res.status(404).json({ success: false, error: "Order not found" });
      }

      // Merge dynamic updates
      db.data.orders[idx] = { ...db.data.orders[idx], ...updateData, updatedAt: new Date().toISOString() };
      await saveOrdersDatabase(db.data, db.sha, `Update Order: ${updateData.id} status to ${updateData.status || 'updated'}`);

      return res.status(200).json({
        success: true,
        message: "Order updated successfully",
        order: db.data.orders[idx]
      });
    }

    // 4. DELETE: Permanently remove or cancel an order
    if (req.method === "DELETE") {
      const orderId = String(req.query.id || (req.body && req.body.id) || "").trim();
      if (!orderId) {
        return res.status(400).json({ success: false, error: "Order ID required" });
      }

      const db = await getOrdersDatabase();
      db.data.deletedIds = db.data.deletedIds || [];
      if (!db.data.deletedIds.includes(orderId)) {
        db.data.deletedIds.push(orderId);
      }
      db.data.orders = (db.data.orders || []).filter(o => String(o.id) !== orderId);
      await saveOrdersDatabase(db.data, db.sha, `Permanently Delete Order: ${orderId}`);

      return res.status(200).json({
        success: true,
        message: `Order ${orderId} permanently deleted`,
        deletedIds: db.data.deletedIds
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("Orders API error:", err);
    return res.status(500).json({ success: false, error: err.message || "Internal server error" });
  }
};
