const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const BCRYPT_ROUNDS = 12;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const DUMMY_PASSWORD_HASH = "$2b$12$fXCXRasefwDuiGhZdUmS6e9q6gOEVaqAM0NC8PLy2.a4gXAUNdRK2";
const failedLoginAttempts = new Map();

function normalizedUsername(value) {
  return typeof value === "string" ? value.trim() : "";
}

function usernameValidationError(username) {
  if (!username) return "Username is required";
  if (username.length < 3 || username.length > 64) return "Username must be between 3 and 64 characters";
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) return "Username may only contain letters, numbers, dots, underscores, and hyphens";
  return null;
}

function passwordValidationError(password) {
  if (typeof password !== "string" || !password) return "Password is required";
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (bcrypt.truncates(password)) return "Password must not exceed 72 UTF-8 bytes";
  return null;
}

function sessionTokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function bearerToken(req) {
  const header = req.header("authorization") || "";
  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  return match && match[1].length <= 512 ? match[1] : "";
}

function setNoStore(res) {
  res.setHeader("Cache-Control", "no-store");
}

async function ensureInitialAdmin(pool) {
  const existing = await pool.query("SELECT id FROM admin_users LIMIT 1");
  if (existing.rows.length) return;

  const username = normalizedUsername(process.env.ADMIN_USERNAME);
  const password = process.env.ADMIN_PASSWORD;
  const validationError = usernameValidationError(username) || passwordValidationError(password);
  if (validationError) {
    const error = new Error("Set valid ADMIN_USERNAME and ADMIN_PASSWORD environment variables before the first login");
    error.code = "ADMIN_AUTH_NOT_CONFIGURED";
    throw error;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await pool.query(`
    INSERT INTO admin_users (username, password_hash)
    SELECT $1, $2
    WHERE NOT EXISTS (SELECT 1 FROM admin_users)
    ON CONFLICT ((LOWER(username))) DO NOTHING
  `, [username, passwordHash]);
}

function loginAttemptKey(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function recentFailedAttempts(key) {
  const cutoff = Date.now() - 15 * 60 * 1000;
  const attempts = (failedLoginAttempts.get(key) || []).filter((timestamp) => timestamp > cutoff);
  if (attempts.length) failedLoginAttempts.set(key, attempts);
  else failedLoginAttempts.delete(key);
  return attempts;
}

function createRequireAdminSession(pool) {
  return async function requireAdminSession(req, res, next) {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ success: false, message: "Authentication required" });

    try {
      const { rows } = await pool.query(`
        SELECT s.id AS session_id, s.admin_user_id, u.username
        FROM admin_sessions s
        JOIN admin_users u ON u.id = s.admin_user_id
        WHERE s.token_hash = $1 AND s.expires_at > NOW()
        LIMIT 1
      `, [sessionTokenHash(token)]);
      if (!rows.length) return res.status(401).json({ success: false, message: "Authentication required" });
      req.admin = {
        session_id: rows[0].session_id,
        user_id: rows[0].admin_user_id,
        username: rows[0].username,
      };
      return next();
    } catch (error) {
      console.error("Admin session validation error:", error);
      return res.status(500).json({ success: false, message: "Authentication unavailable" });
    }
  };
}

function registerAdminAuthRoutes(app, pool) {
  const requireAdminSession = createRequireAdminSession(pool);

  app.post("/admin/login", async (req, res) => {
    const username = normalizedUsername(req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const attemptKey = loginAttemptKey(req);
    const attempts = recentFailedAttempts(attemptKey);
    setNoStore(res);

    if (attempts.length >= 10) {
      return res.status(429).json({ success: false, message: "Too many authentication attempts; try again later" });
    }

    try {
      await ensureInitialAdmin(pool);
      const { rows } = await pool.query(`
        SELECT id, username, password_hash
        FROM admin_users
        WHERE LOWER(username) = LOWER($1)
        LIMIT 1
      `, [username]);
      const user = rows[0];
      const passwordMatches = await bcrypt.compare(password, user?.password_hash || DUMMY_PASSWORD_HASH);
      if (!user || !passwordMatches) {
        attempts.push(Date.now());
        failedLoginAttempts.set(attemptKey, attempts);
        return res.status(401).json({ success: false, message: "Invalid username or password." });
      }

      failedLoginAttempts.delete(attemptKey);
      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      await pool.query("DELETE FROM admin_sessions WHERE expires_at <= NOW()");
      await pool.query(`
        INSERT INTO admin_sessions (admin_user_id, token_hash, expires_at)
        VALUES ($1, $2, $3)
      `, [user.id, sessionTokenHash(token), expiresAt]);
      return res.json({
        success: true,
        token,
        expires_at: expiresAt.toISOString(),
        admin: { username: user.username },
      });
    } catch (error) {
      if (["ADMIN_AUTH_NOT_CONFIGURED", "42P01"].includes(error.code)) {
        console.error(error.message);
        return res.status(503).json({ success: false, message: "Admin authentication is not configured" });
      }
      console.error("Admin login error:", error);
      return res.status(500).json({ success: false, message: "Unable to sign in" });
    }
  });

  app.post("/admin/logout", requireAdminSession, async (req, res) => {
    setNoStore(res);
    try {
      await pool.query("DELETE FROM admin_sessions WHERE id = $1", [req.admin.session_id]);
      return res.json({ success: true });
    } catch (error) {
      console.error("Admin logout error:", error);
      return res.status(500).json({ success: false, message: "Unable to log out" });
    }
  });

  app.post("/admin/change-password", requireAdminSession, async (req, res) => {
    const currentPassword = typeof req.body?.current_password === "string" ? req.body.current_password : "";
    const newPassword = typeof req.body?.new_password === "string" ? req.body.new_password : "";
    const confirmPassword = typeof req.body?.confirm_password === "string" ? req.body.confirm_password : "";
    setNoStore(res);

    if (!currentPassword) return res.status(400).json({ success: false, message: "Current password is required" });
    if (!confirmPassword) return res.status(400).json({ success: false, message: "Password confirmation is required" });
    if (newPassword !== confirmPassword) return res.status(400).json({ success: false, message: "New passwords do not match" });
    const validationError = passwordValidationError(newPassword);
    if (validationError) return res.status(400).json({ success: false, message: validationError });

    try {
      const { rows } = await pool.query("SELECT password_hash FROM admin_users WHERE id = $1", [req.admin.user_id]);
      if (!rows.length || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
        return res.status(400).json({ success: false, message: "Current password is incorrect" });
      }
      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("UPDATE admin_users SET password_hash = $1, updated_at = NOW() WHERE id = $2", [passwordHash, req.admin.user_id]);
        await client.query("DELETE FROM admin_sessions WHERE admin_user_id = $1 AND id <> $2", [req.admin.user_id, req.admin.session_id]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return res.json({ success: true, message: "Password changed successfully." });
    } catch (error) {
      console.error("Change admin password error:", error);
      return res.status(500).json({ success: false, message: "Unable to change password" });
    }
  });

  app.patch("/admin/account/username", requireAdminSession, async (req, res) => {
    const username = normalizedUsername(req.body?.username);
    const validationError = usernameValidationError(username);
    setNoStore(res);
    if (validationError) return res.status(400).json({ success: false, message: validationError });

    try {
      const { rows } = await pool.query(`
        UPDATE admin_users SET username = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING username, updated_at
      `, [username, req.admin.user_id]);
      return res.json({ success: true, admin: rows[0] });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ success: false, message: "Username is unavailable" });
      console.error("Update admin username error:", error);
      return res.status(500).json({ success: false, message: "Unable to update username" });
    }
  });

  return requireAdminSession;
}

module.exports = {
  createRequireAdminSession,
  ensureInitialAdmin,
  passwordValidationError,
  registerAdminAuthRoutes,
  sessionTokenHash,
  usernameValidationError,
};
