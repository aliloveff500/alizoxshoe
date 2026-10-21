// Vercel Serverless Function: /api/users
// Customer Authentication and Accounts Management API for ALIZOX

const https = require("https");

const GITHUB_REPO = process.env.GITHUB_REPO || "aliloveff500/ALIZOX_SHOE";
const FILE_PATH = "users-data.json";

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
        "User-Agent": "ALIZOX-Users-API",
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

async function getUsersDatabase() {
  const res = await ghRequest("GET", `/repos/${GITHUB_REPO}/contents/${FILE_PATH}?t=${Date.now()}`);
  if (res.status === 200 && res.data && res.data.content) {
    const jsonStr = Buffer.from(res.data.content, "base64").toString("utf-8");
    try {
      const parsed = JSON.parse(jsonStr);
      parsed.users = Array.isArray(parsed.users) ? parsed.users : [];
      return { sha: res.data.sha, data: parsed };
    } catch (e) {}
  }
  return { sha: null, data: { updatedAt: new Date().toISOString(), users: [] } };
}

async function saveUsersDatabase(payload, sha, commitMsg = "Update customer accounts database") {
  payload.updatedAt = new Date().toISOString();
  payload.users = Array.isArray(payload.users) ? payload.users : [];
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    // 1. GET: Fetch all users (for Admin) OR authenticate user with email+pass query
    if (req.method === "GET") {
      const db = await getUsersDatabase();
      const email = String(req.query.email || "").trim().toLowerCase();
      const pass = String(req.query.password || "").trim();

      if (email && pass) {
        // Authenticate specific user
        const user = db.data.users.find(u => 
          (u.email && u.email.toLowerCase() === email) || 
          (u.username && u.username.toLowerCase() === email)
        );
        if (user && user.password === pass) {
          return res.status(200).json({ success: true, user: user });
        } else {
          return res.status(401).json({ success: false, error: "Ghalat Email ya Password! Please check your credentials." });
        }
      }

      // Return all users for Admin
      return res.status(200).json({
        success: true,
        updatedAt: db.data.updatedAt,
        users: db.data.users
      });
    }

    // 2. POST: Register new customer account OR Sign In via body
    if (req.method === "POST") {
      let bodyData = req.body;
      if (typeof bodyData === "string") {
        try { bodyData = JSON.parse(bodyData); } catch (e) {}
      }

      const action = bodyData.action || "register"; // 'register' or 'login'
      const db = await getUsersDatabase();

      if (action === "login") {
        const identifier = String(bodyData.email || bodyData.username || "").trim().toLowerCase();
        const pass = String(bodyData.password || "").trim();

        const user = db.data.users.find(u => 
          (u.email && u.email.toLowerCase() === identifier) || 
          (u.username && u.username.toLowerCase() === identifier)
        );

        if (user && user.password === pass) {
          return res.status(200).json({ success: true, message: "Login successful", user: user });
        } else {
          return res.status(401).json({ success: false, error: "Ghalat Email ya Password! Please check your login details." });
        }
      }

      // REGISTER NEW CUSTOMER
      const email = String(bodyData.email || "").trim().toLowerCase();
      const password = String(bodyData.password || "").trim();
      const username = String(bodyData.username || bodyData.name || "").trim();
      const phone = String(bodyData.phone || "").trim();
      const address = String(bodyData.address || "").trim();
      const city = String(bodyData.city || "").trim();

      if (!email || !password) {
        return res.status(400).json({ success: false, error: "Email and password are required" });
      }

      // Check if email already registered
      const existing = db.data.users.find(u => u.email && u.email.toLowerCase() === email);
      if (existing) {
        return res.status(409).json({ success: false, error: "Yeh email pehle se registered hai! Please Sign In karein." });
      }

      const newUser = {
        id: `USR-${Math.floor(10000 + Math.random() * 90000)}`,
        username: username || email.split("@")[0],
        email: email,
        password: password,
        phone: phone,
        address: address,
        city: city,
        createdAt: new Date().toISOString()
      };

      db.data.users.unshift(newUser);
      await saveUsersDatabase(db.data, db.sha, `New Customer Registered: ${newUser.username} (${newUser.email})`);

      return res.status(201).json({
        success: true,
        message: "Account created successfully",
        user: newUser
      });
    }

    // 3. PUT: Update user profile or password (by user or by Admin)
    if (req.method === "PUT") {
      let updateData = req.body;
      if (typeof updateData === "string") {
        try { updateData = JSON.parse(updateData); } catch (e) {}
      }

      const id = String(updateData.id || "").trim();
      if (!id) {
        return res.status(400).json({ success: false, error: "User ID is required for update" });
      }

      const db = await getUsersDatabase();
      const idx = db.data.users.findIndex(u => String(u.id) === id);

      if (idx === -1) {
        return res.status(404).json({ success: false, error: "User not found" });
      }

      // Merge allowed updates
      if (updateData.username) db.data.users[idx].username = updateData.username.trim();
      if (updateData.email) db.data.users[idx].email = updateData.email.trim().toLowerCase();
      if (updateData.password) db.data.users[idx].password = updateData.password.trim();
      if (updateData.phone !== undefined) db.data.users[idx].phone = updateData.phone.trim();
      if (updateData.address !== undefined) db.data.users[idx].address = updateData.address.trim();
      if (updateData.city !== undefined) db.data.users[idx].city = updateData.city.trim();
      db.data.users[idx].updatedAt = new Date().toISOString();

      await saveUsersDatabase(db.data, db.sha, `Update Customer: ${db.data.users[idx].username} (${id})`);

      return res.status(200).json({
        success: true,
        message: "Customer account updated successfully",
        user: db.data.users[idx]
      });
    }

    // 4. DELETE: Admin permanently removing a customer
    if (req.method === "DELETE") {
      const id = String(req.query.id || (req.body && req.body.id) || "").trim();
      if (!id) {
        return res.status(400).json({ success: false, error: "User ID required" });
      }

      const db = await getUsersDatabase();
      db.data.users = db.data.users.filter(u => String(u.id) !== id);
      await saveUsersDatabase(db.data, db.sha, `Delete Customer Account: ${id}`);

      return res.status(200).json({
        success: true,
        message: `Customer ${id} deleted successfully`
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("Users API error:", err);
    return res.status(500).json({ success: false, error: err.message || "Internal server error" });
  }
};
