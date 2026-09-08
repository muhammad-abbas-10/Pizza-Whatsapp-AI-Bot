const assert = require("assert/strict");
const bcrypt = require("bcryptjs");
const express = require("express");
const { ensureInitialAdmin, registerAdminAuthRoutes } = require("../src/admin-auth");

function fakePool(passwordHash) {
  const state = {
    user: passwordHash ? { id: "1", username: "admin", password_hash: passwordHash, updated_at: new Date().toISOString() } : null,
    sessions: [],
    nextSessionId: 1,
  };

  async function query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, " ").trim();
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
    if (text.startsWith("SELECT id FROM admin_users LIMIT 1")) return { rows: state.user ? [{ id: state.user.id }] : [] };
    if (text.startsWith("INSERT INTO admin_users")) {
      if (!state.user) state.user = { id: "1", username: params[0], password_hash: params[1], updated_at: new Date().toISOString() };
      return { rows: [] };
    }
    if (text.includes("SELECT id, username, password_hash") && text.includes("FROM admin_users")) {
      return { rows: state.user?.username.toLowerCase() === String(params[0]).toLowerCase() ? [{ ...state.user }] : [] };
    }
    if (text.startsWith("DELETE FROM admin_sessions WHERE expires_at <= NOW()")) {
      state.sessions = state.sessions.filter((session) => session.expires_at > new Date());
      return { rows: [] };
    }
    if (text.startsWith("INSERT INTO admin_sessions")) {
      state.sessions.push({ id: String(state.nextSessionId++), admin_user_id: String(params[0]), token_hash: params[1], expires_at: new Date(params[2]) });
      return { rows: [] };
    }
    if (text.includes("SELECT s.id AS session_id") && text.includes("FROM admin_sessions s")) {
      const session = state.sessions.find((item) => item.token_hash === params[0] && item.expires_at > new Date());
      return { rows: session ? [{ session_id: session.id, admin_user_id: session.admin_user_id, username: state.user.username }] : [] };
    }
    if (text.startsWith("DELETE FROM admin_sessions WHERE id = $1")) {
      state.sessions = state.sessions.filter((session) => session.id !== String(params[0]));
      return { rows: [] };
    }
    if (text.startsWith("SELECT password_hash FROM admin_users WHERE id = $1")) {
      return { rows: String(params[0]) === state.user.id ? [{ password_hash: state.user.password_hash }] : [] };
    }
    if (text.startsWith("UPDATE admin_users SET password_hash")) {
      state.user.password_hash = params[0];
      state.user.updated_at = new Date().toISOString();
      return { rows: [] };
    }
    if (text.startsWith("DELETE FROM admin_sessions WHERE admin_user_id")) {
      state.sessions = state.sessions.filter((session) => session.admin_user_id !== String(params[0]) || session.id === String(params[1]));
      return { rows: [] };
    }
    if (text.startsWith("UPDATE admin_users SET username")) {
      state.user.username = params[0];
      state.user.updated_at = new Date().toISOString();
      return { rows: [{ username: state.user.username, updated_at: state.user.updated_at }] };
    }
    throw new Error(`Unexpected auth query: ${text}`);
  }

  return {
    state,
    query,
    async connect() {
      return { query, release() {} };
    },
  };
}

async function request(baseUrl, method, path, body, token) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  const previousUsername = process.env.ADMIN_USERNAME;
  const previousPassword = process.env.ADMIN_PASSWORD;
  const bootstrapPool = fakePool();
  process.env.ADMIN_USERNAME = "bootstrap-admin";
  process.env.ADMIN_PASSWORD = "bootstrap-password";
  try {
    await ensureInitialAdmin(bootstrapPool);
    assert.equal(bootstrapPool.state.user.username, "bootstrap-admin");
    assert.notEqual(bootstrapPool.state.user.password_hash, "bootstrap-password");
    assert(await bcrypt.compare("bootstrap-password", bootstrapPool.state.user.password_hash));
  } finally {
    if (previousUsername === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousPassword;
  }

  const pool = fakePool(await bcrypt.hash("old-password", 12));
  const app = express();
  app.use(express.json());
  const requireAdminSession = registerAdminAuthRoutes(app, pool);
  app.get("/protected", requireAdminSession, (req, res) => res.json({ username: req.admin.username }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    assert.equal((await request(baseUrl, "GET", "/protected")).status, 401);

    const wrongUsername = await request(baseUrl, "POST", "/admin/login", { username: "nobody", password: "old-password" });
    assert.equal(wrongUsername.status, 401);
    assert.equal(wrongUsername.body.message, "Invalid username or password.");
    const wrongPassword = await request(baseUrl, "POST", "/admin/login", { username: "admin", password: "wrong-password" });
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.body.message, wrongUsername.body.message);

    const login = await request(baseUrl, "POST", "/admin/login", { username: "admin", password: "old-password" });
    assert.equal(login.status, 200);
    assert(login.body.token);
    assert.equal((await request(baseUrl, "GET", "/protected", undefined, login.body.token)).status, 200);

    const mismatch = await request(baseUrl, "POST", "/admin/change-password", {
      current_password: "old-password", new_password: "new-password", confirm_password: "different-password",
    }, login.body.token);
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.message, "New passwords do not match");
    assert(await bcrypt.compare("old-password", pool.state.user.password_hash));

    const incorrectCurrent = await request(baseUrl, "POST", "/admin/change-password", {
      current_password: "incorrect", new_password: "new-password", confirm_password: "new-password",
    }, login.body.token);
    assert.equal(incorrectCurrent.status, 400);
    assert.equal(incorrectCurrent.body.message, "Current password is incorrect");

    const changed = await request(baseUrl, "POST", "/admin/change-password", {
      current_password: "old-password", new_password: "new-password", confirm_password: "new-password",
    }, login.body.token);
    assert.equal(changed.status, 200);
    assert.equal(changed.body.message, "Password changed successfully.");
    assert.equal((await request(baseUrl, "POST", "/admin/login", { username: "admin", password: "old-password" })).status, 401);
    const newLogin = await request(baseUrl, "POST", "/admin/login", { username: "admin", password: "new-password" });
    assert.equal(newLogin.status, 200);

    const renamed = await request(baseUrl, "PATCH", "/admin/account/username", { username: "pizza-admin" }, newLogin.body.token);
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.admin.username, "pizza-admin");

    assert.equal((await request(baseUrl, "POST", "/admin/logout", undefined, newLogin.body.token)).status, 200);
    assert.equal((await request(baseUrl, "GET", "/protected", undefined, newLogin.body.token)).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("Admin username/password, session, password change, username change, and logout tests: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
