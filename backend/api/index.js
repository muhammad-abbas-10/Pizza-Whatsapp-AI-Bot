const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const { registerAdminRoutes } = require("../src/admin-routes");

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

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  : ["*"];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests without an Origin header
      // (Postman, server-to-server, etc.)
      if (!origin) {
        return callback(null, true);
      }

      // Allow all origins if CORS_ORIGINS=*
      if (allowedOrigins.includes("*")) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error("Not allowed by CORS")
      );
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// --------------------------------------------------
// BODY PARSERS
// --------------------------------------------------

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// --------------------------------------------------
// NEON DATABASE
// --------------------------------------------------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

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
    if (!file.mimetype.startsWith("image/")) {
      return cb(
        new Error("Only image files are allowed")
      );
    }

    cb(null, true);
  },
});

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
  console.error("Image retrieval error:", error);

  return res.status(500).json({
    success: false,
    message: "Failed to retrieve image",
    error: error.message,
  });
}
});

// --------------------------------------------------
// ADMIN DASHBOARD ROUTES (orders + approve/deny requests)
// --------------------------------------------------

registerAdminRoutes(app, pool);

// --------------------------------------------------
// UPLOAD 2–3 IMAGES
// --------------------------------------------------

app.post(
  "/images/upload",
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
    const id = Number.parseInt(req.params.id, 10);

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