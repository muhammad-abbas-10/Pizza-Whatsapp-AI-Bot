const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

// Allow requests from the test HTML page and later from Vercel
app.use(cors());

// Neon PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Store uploaded files temporarily in memory
const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB per image
    files: 3,                    // maximum 3 images
  },

  fileFilter: (req, file, cb) => {
    // Only allow image files
    if (file.mimetype && file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

// --------------------------------------------------
// TEST ROUTE
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Image backend is running",
  });
});

// --------------------------------------------------
// UPLOAD 2–3 IMAGES
// --------------------------------------------------

app.post(
  "/images/upload",
  upload.array("images", 3),
  async (req, res) => {
    try {
      // Check that files were received
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No images uploaded",
        });
      }

      // We require 2–3 images
      if (req.files.length < 2 || req.files.length > 3) {
        return res.status(400).json({
          success: false,
          message: "Please upload between 2 and 3 images",
          received: req.files.length,
        });
      }

      const client = await pool.connect();

      try {
        // Start database transaction
        await client.query("BEGIN");

        const uploadedImages = [];

        // Save every image separately
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

        // Save all images permanently
        await client.query("COMMIT");

        return res.status(201).json({
          success: true,
          message: "Images uploaded successfully",
          count: uploadedImages.length,
          images: uploadedImages,
        });
      } catch (databaseError) {
        // Undo all inserts if anything fails
        await client.query("ROLLBACK");

        throw databaseError;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Image upload error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to upload images",
        error: error.message,
      });
    }
  }
);

// --------------------------------------------------
// MULTER / OTHER ERRORS
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error("Request error:", error);

  return res.status(500).json({
    success: false,
    message: error.message || "Server error",
  });
});
// --------------------------------------------------
// GET IMAGE
// --------------------------------------------------

app.get("/images/:id", async (req, res) => {
  try {
    const imageId = Number(req.params.id);

    if (!Number.isInteger(imageId) || imageId <= 0) {
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
      `,
      [imageId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Image not found",
      });
    }

    const image = result.rows[0];

    // Tell browser/WhatsApp what type of image this is
    res.setHeader("Content-Type", image.mime_type);

    // Return the actual image binary
    res.send(image.image_data);

  } catch (error) {
    console.error("Image retrieval error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to retrieve image",
    });
  }
});
// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});