import express from "express";
import pg from "pg";

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ─────────────────────────────────────────────
// Environment variables
// ─────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TEST_CHAT_ID = process.env.TELEGRAM_TEST_CHAT_ID;
const CHANNEL_USERNAME = process.env.TELEGRAM_CHANNEL_USERNAME;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is not configured");
}

// ─────────────────────────────────────────────
// PostgreSQL connection
// ─────────────────────────────────────────────

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ─────────────────────────────────────────────
// Database initialization
// ─────────────────────────────────────────────

async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS content (
        id SERIAL PRIMARY KEY,
        title TEXT,
        body TEXT,
        category TEXT,
        source TEXT,
        source_url TEXT,
        ai_score INTEGER DEFAULT 0,
        status TEXT DEFAULT 'draft',
        telegram_message_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        published_at TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sources (
        id SERIAL PRIMARY KEY,
        name TEXT,
        url TEXT,
        category TEXT,
        active INTEGER DEFAULT 1,
        reliability INTEGER DEFAULT 50,
        last_checked TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS affiliate (
        id SERIAL PRIMARY KEY,
        product TEXT,
        company TEXT,
        url TEXT,
        affiliate_url TEXT,
        commission TEXT,
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS analytics (
        id SERIAL PRIMARY KEY,
        content_id INTEGER,
        views INTEGER DEFAULT 0,
        reactions INTEGER DEFAULT 0,
        comments INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        ctr REAL DEFAULT 0,
        performance_score REAL DEFAULT 0,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("PostgreSQL database initialized successfully");
  } catch (error) {
    console.error("Database initialization error:", error);
  }
}

// ─────────────────────────────────────────────
// Telegram helper
// ─────────────────────────────────────────────

async function telegram(method, body = {}) {
  if (!BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  return await response.json();
}

// ─────────────────────────────────────────────
// Home
// ─────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    service: "AI Opportunity Hub",
    status: "online",
    database: "Neon PostgreSQL"
  });
});

// ─────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      service: "AI Opportunity Hub",
      database: "connected"
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      database: "disconnected",
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Telegram connection test
// ─────────────────────────────────────────────

app.get("/telegram-test", async (req, res) => {
  try {
    const result = await telegram("getMe");

    res.json({
      connected: result.ok,
      bot: result.result || null
    });
  } catch (error) {
    res.status(500).json({
      connected: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Private Telegram test
// ─────────────────────────────────────────────

app.get("/send-test", async (req, res) => {
  try {
    if (!TEST_CHAT_ID) {
      return res.status(500).json({
        error: "TELEGRAM_TEST_CHAT_ID is not configured"
      });
    }

    const result = await telegram("sendMessage", {
      chat_id: TEST_CHAT_ID,
      text: "🤖 AI Opportunity Hub PostgreSQL backend is connected."
    });

    res.json({
      sent: result.ok,
      message_id: result.result?.message_id || null
    });
  } catch (error) {
    res.status(500).json({
      sent: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Channel publishing test
// ─────────────────────────────────────────────

app.get("/publish-test", async (req, res) => {
  try {
    if (!CHANNEL_USERNAME) {
      return res.status(500).json({
        error: "TELEGRAM_CHANNEL_USERNAME is not configured"
      });
    }

    const result = await telegram("sendMessage", {
      chat_id: CHANNEL_USERNAME,
      text:
        "🚀 AI Opportunity Hub\n\n" +
        "Neon PostgreSQL database is connected successfully."
    });

    res.json({
      published: result.ok,
      message_id: result.result?.message_id || null,
      channel: CHANNEL_USERNAME
    });
  } catch (error) {
    res.status(500).json({
      published: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Database status
// ─────────────────────────────────────────────

app.get("/database-test", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    res.json({
      database: "connected",
      tables: result.rows
    });
  } catch (error) {
    res.status(500).json({
      database: "error",
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Create content using JSON
// ─────────────────────────────────────────────

app.post("/content-test", async (req, res) => {
  try {
    const {
      title,
      body,
      category,
      source,
      source_url
    } = req.body;

    if (!title || !body) {
      return res.status(400).json({
        error: "title and body are required"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO content (
        title,
        body,
        category,
        source,
        source_url,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
      `,
      [
        title,
        body,
        category || "AI Tools",
        source || "Manual",
        source_url || "",
        "draft"
      ]
    );

    res.json({
      saved: true,
      content_id: result.rows[0].id
    });
  } catch (error) {
    res.status(500).json({
      saved: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Browser-friendly content test
// ─────────────────────────────────────────────

app.get("/content-test", async (req, res) => {
  try {
    const result = await pool.query(
      `
      INSERT INTO content (
        title,
        body,
        category,
        source,
        source_url,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
      `,
      [
        "5 Free AI Tools You Should Try",
        "Here are five useful AI tools that can help with writing, research, productivity, and content creation.",
        "AI Tools",
        "AI Opportunity Hub",
        "",
        "draft"
      ]
    );

    res.json({
      saved: true,
      content_id: result.rows[0].id
    });
  } catch (error) {
    res.status(500).json({
      saved: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Get all content
// ─────────────────────────────────────────────

app.get("/content", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM content
      ORDER BY created_at DESC
    `);

    res.json({
      count: result.rows.length,
      content: result.rows
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────

async function startServer() {
  await initializeDatabase();

  app.listen(PORT, () => {
    console.log(`AI Opportunity Hub running on port ${PORT}`);
  });
}

startServer();
