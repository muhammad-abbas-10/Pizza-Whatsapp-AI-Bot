const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const { attachDatabasePool } = require("@vercel/functions");
const { createRequireAdminSession, registerAdminRoutes } = require("../src/admin-routes");

const app = express();

// --------------------------------------------------
// ENVIRONMENT CHECK
// --------------------------------------------------

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not configured.");
}

// --------------------------------------------------
// CORS
// --------------------------------------------------

function normalizeOrigin(value) {
  const candidate = String(value || "").trim().replace(/\/$/, "");
  if (!candidate) return null;
  try {
    const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(candidate)
      ? candidate
      : `https://${candidate}`;
    return new URL(withProtocol).origin;
  } catch {
    return null;
  }
}

const configuredOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",")
  : ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"];
const allowedOrigins = new Set(
  [...configuredOrigins, process.env.FRONTEND_URL]
    .map(normalizeOrigin)
    .filter(Boolean)
);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests without an Origin header
      // (Postman, server-to-server, etc.)
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.has(normalizeOrigin(origin))) {
        return callback(null, true);
      }

      return callback(
        new Error("Not allowed by CORS")
      );
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);

// --------------------------------------------------
// BODY PARSERS
// --------------------------------------------------

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.get(["/dashboard", "/dashboard/"], (req, res) => {
  return res.redirect(302, normalizeOrigin(process.env.FRONTEND_URL) || "http://localhost:5173");
});

// --------------------------------------------------
// NEON DATABASE
// --------------------------------------------------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  // Admin queries are short; one client avoids opening several expensive Neon
  // connections when the shell and active page load concurrently on a cold function.
  max: 1,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 10000,
});

// Let Vercel Fluid Compute release idle clients safely when an instance is
// suspended while keeping this module-level pool reusable between requests.
attachDatabasePool(pool);

// --------------------------------------------------
// MULTER
// --------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB per image
    files: 3,
  },

  fileFilter: (req, file, cb) => {
    if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.mimetype)) {
      return cb(
        new Error("Only image files are allowed")
      );
    }

    cb(null, true);
  },
});

function hasValidImageSignature(file) {
  const bytes = file.buffer;
  if (file.mimetype === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.mimetype === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (file.mimetype === "image/gif") return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  if (file.mimetype === "image/webp") return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Image backend is running on Vercel",
  });
});

// --------------------------------------------------
// DATABASE HEALTH CHECK
// --------------------------------------------------

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    return res.status(200).json({
      success: true,
      database: "connected",
    });
} catch (error) {
  console.error("Database health check error:", error);

  return res.status(500).json({
    success: false,
    message: "Database unavailable",
  });
}
});

// --------------------------------------------------
// ADMIN DASHBOARD ROUTES (orders + approve/deny requests)
// --------------------------------------------------

registerAdminRoutes(app, pool);
const requireAdminSession = createRequireAdminSession(pool);

// --------------------------------------------------
// UPLOAD 2–3 IMAGES
// --------------------------------------------------

app.post(
  "/images/upload",
  requireAdminSession,
  upload.array("images", 3),
  async (req, res) => {
    try {
      // ----------------------------------------------
      // CHECK FILES
      // ----------------------------------------------

      if (!req.files || !Array.isArray(req.files)) {
        return res.status(400).json({
          success: false,
          message: "No images uploaded",
        });
      }

      if (req.files.length < 2) {
        return res.status(400).json({
          success: false,
          message: "Please upload at least 2 images",
          received: req.files.length,
        });
      }

      if (req.files.length > 3) {
        return res.status(400).json({
          success: false,
          message: "Maximum 3 images are allowed",
          received: req.files.length,
        });
      }

      if (!req.files.every(hasValidImageSignature)) {
        return res.status(400).json({
          success: false,
          message: "One or more files do not contain valid image data",
        });
      }

      // ----------------------------------------------
      // DATABASE TRANSACTION
      // ----------------------------------------------

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const uploadedImages = [];

        for (const file of req.files) {
          const result = await client.query(
            `
            INSERT INTO menu_images
              (name, mime_type, image_data)
            VALUES
              ($1, $2, $3)
            RETURNING
              id,
              name,
              mime_type,
              active,
              created_at
            `,
            [
              file.originalname,
              file.mimetype,
              file.buffer,
            ]
          );

          uploadedImages.push(result.rows[0]);
        }

        await client.query("COMMIT");

        return res.status(201).json({
          success: true,
          message: "Images uploaded successfully",
          count: uploadedImages.length,
          images: uploadedImages,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Image upload error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to upload images",
      });
    }
  }
);

// --------------------------------------------------
// GET IMAGE
// --------------------------------------------------

app.get("/images/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid image ID",
      });
    }

    const result = await pool.query(
      `
      SELECT
        image_data,
        mime_type
      FROM menu_images
      WHERE id = $1
        AND active = TRUE
      LIMIT 1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Image not found",
      });
    }

    const image = result.rows[0];

    res.setHeader(
      "Content-Type",
      image.mime_type
    );

    res.setHeader(
      "Content-Length",
      image.image_data.length
    );

    res.setHeader(
      "Cache-Control",
      "public, max-age=3600"
    );
    res.setHeader("X-Content-Type-Options", "nosniff");

    return res.send(image.image_data);
  } catch (error) {
    console.error(
      "Image retrieval error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve image",
    });
  }
});

// --------------------------------------------------
// LIST IMAGES
// --------------------------------------------------

app.get("/images", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        name,
        mime_type,
        active,
        created_at
      FROM menu_images
      WHERE active = TRUE
      ORDER BY display_order ASC, created_at DESC
      `
    );

    const images = result.rows.map((image) => ({
      ...image,
      url: `/images/${image.id}`,
    }));

    return res.status(200).json({
      success: true,
      count: images.length,
      images,
    });
  } catch (error) {
    console.error(
      "Image list error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve images",
    });
  }
});

// --------------------------------------------------
// MULTER / GENERAL ERROR HANDLER
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error("Server error:", error);

  // Multer errors
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: "Each image must be 10 MB or smaller",
      });
    }

    if (error.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({
        success: false,
        message: "Maximum 3 images are allowed",
      });
    }

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  // File type error
  if (
    error.message ===
    "Only image files are allowed"
  ) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  // CORS error
  if (
    error.message ===
    "Not allowed by CORS"
  ) {
    return res.status(403).json({
      success: false,
      message: "CORS origin not allowed",
    });
  }

  return res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

// --------------------------------------------------
// VERCEL
// --------------------------------------------------

module.exports = app;
