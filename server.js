import express from "express";
import Database from "better-sqlite3";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ─────────────────────────────────────────────
// Environment variables
// ─────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TEST_CHAT_ID = process.env.TELEGRAM_TEST_CHAT_ID;
const CHANNEL_USERNAME = process.env.TELEGRAM_CHANNEL_USERNAME;

// ─────────────────────────────────────────────
// SQLite database
// ─────────────────────────────────────────────

const db = new Database("ai_opportunity_hub.db");

db.pragma("journal_mode = WAL");

// ─────────────────────────────────────────────
// Database tables
// ─────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    body TEXT,
    category TEXT,
    source TEXT,
    source_url TEXT,
    ai_score INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',
    telegram_message_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    published_at DATETIME
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    url TEXT,
    category TEXT,
    active INTEGER DEFAULT 1,
    reliability INTEGER DEFAULT 50,
    last_checked DATETIME
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS affiliate (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product TEXT,
    company TEXT,
    url TEXT,
    affiliate_url TEXT,
    commission TEXT,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER,
    views INTEGER DEFAULT 0,
    reactions INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    ctr REAL DEFAULT 0,
    performance_score REAL DEFAULT 0,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

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
    database: "SQLite"
  });
});

// ─────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "AI Opportunity Hub",
    database: "connected"
  });
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
      text: "🤖 AI Opportunity Hub database backend is connected."
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
        "SQLite database is connected successfully."
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

app.get("/database-test", (req, res) => {
  try {
    const tables = db
      .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
        ORDER BY name
      `)
      .all();

    res.json({
      database: "connected",
      tables
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

app.post("/content-test", (req, res) => {
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

    const result = db
      .prepare(`
        INSERT INTO content (
          title,
          body,
          category,
          source,
          source_url,
          status
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        title,
        body,
        category || "AI Tools",
        source || "Manual",
        source_url || "",
        "draft"
      );

    res.json({
      saved: true,
      content_id: result.lastInsertRowid
    });
  } catch (error) {
    res.status(500).json({
      saved: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Browser-friendly database test
// ─────────────────────────────────────────────

app.get("/content-test", (req, res) => {
  try {
    const result = db
      .prepare(`
        INSERT INTO content (
          title,
          body,
          category,
          source,
          source_url,
          status
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        "5 Free AI Tools You Should Try",
        "Here are five useful AI tools that can help with writing, research, productivity, and content creation.",
        "AI Tools",
        "AI Opportunity Hub",
        "",
        "draft"
      );

    res.json({
      saved: true,
      content_id: result.lastInsertRowid
    });
  } catch (error) {
    res.status(500).json({
      saved: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`AI Opportunity Hub running on port ${PORT}`);
});
