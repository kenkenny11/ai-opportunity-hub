import express from "express";
import pg from "pg";
import * as cheerio from "cheerio";

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

// ─────────────────────────────────────────────
// PostgreSQL
// ─────────────────────────────────────────────

if (!DATABASE_URL) {
  console.error("DATABASE_URL is not configured");
}

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
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        category TEXT DEFAULT 'AI Tools',
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
        name TEXT NOT NULL,
        url TEXT NOT NULL,
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

    console.log("PostgreSQL database initialized");
  } catch (error) {
    console.error("Database initialization error:", error);
    throw error;
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

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.description || "Telegram API request failed");
  }

  return data;
}

// ─────────────────────────────────────────────
// Source fetcher
// ─────────────────────────────────────────────

async function fetchSource(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; AIOpportunityHubBot/1.0)"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `Source returned HTTP ${response.status}`
    );
  }

  return await response.text();
}

// ─────────────────────────────────────────────
// Extract articles from HTML
// ─────────────────────────────────────────────

function extractArticles(html, sourceUrl) {
  const $ = cheerio.load(html);
  const articles = [];
  const seenUrls = new Set();

  $("article, main a, a").each((index, element) => {
    if (articles.length >= 20) {
      return;
    }

    const link = $(element).attr("href");
    const title = $(element).text().replace(/\s+/g, " ").trim();

    if (!link || !title) {
      return;
    }

    if (title.length < 20 || title.length > 250) {
      return;
    }

    const lowerTitle = title.toLowerCase();

    const ignoredWords = [
      "sign in",
      "log in",
      "subscribe",
      "privacy",
      "terms",
      "cookie",
      "contact",
      "about",
      "careers",
      "search",
      "menu"
    ];

    if (
      ignoredWords.some((word) =>
        lowerTitle.includes(word)
      )
    ) {
      return;
    }

    let absoluteUrl;

    try {
      absoluteUrl = new URL(link, sourceUrl).href;
    } catch {
      return;
    }

    if (!absoluteUrl.startsWith("http")) {
      return;
    }

    if (seenUrls.has(absoluteUrl)) {
      return;
    }

    seenUrls.add(absoluteUrl);

    articles.push({
      title,
      url: absoluteUrl
    });
  });

  return articles;
}

// ─────────────────────────────────────────────
// Check duplicate content
// ─────────────────────────────────────────────

async function contentExists(title, sourceUrl) {
  const result = await pool.query(
    `
    SELECT id
    FROM content
    WHERE
      LOWER(title) = LOWER($1)
      OR source_url = $2
    LIMIT 1
    `,
    [title, sourceUrl]
  );

  return result.rows.length > 0;
}

// ─────────────────────────────────────────────
// Collect one source
// ─────────────────────────────────────────────

async function collectSource(source) {
  const html = await fetchSource(source.url);

  const articles = extractArticles(
    html,
    source.url
  );

  let saved = 0;
  let duplicates = 0;

  for (const article of articles) {
    const exists = await contentExists(
      article.title,
      article.url
    );

    if (exists) {
      duplicates++;
      continue;
    }

    await pool.query(
      `
      INSERT INTO content (
        title,
        body,
        category,
        source,
        source_url,
        ai_score,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'draft')
      `,
      [
        article.title,
        `Collected from ${source.name}. AI processing has not been performed yet.`,
        source.category || "AI News",
        source.name,
        article.url,
        0
      ]
    );

    saved++;
  }

  await pool.query(
    `
    UPDATE sources
    SET last_checked = CURRENT_TIMESTAMP
    WHERE id = $1
    `,
    [source.id]
  );

  return {
    source_id: source.id,
    source: source.name,
    found: articles.length,
    saved,
    duplicates
  };
}

// ─────────────────────────────────────────────
// Home
// ─────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    service: "AI Opportunity Hub",
    status: "online",
    database: "Neon PostgreSQL",
    collector: "ready"
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
      database: "connected",
      telegram: BOT_TOKEN ? "configured" : "missing"
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
// Database test
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
// Telegram test
// ─────────────────────────────────────────────

app.get("/telegram-test", async (req, res) => {
  try {
    const result = await telegram("getMe");

    res.json({
      connected: true,
      bot: result.result
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
      text: "🤖 AI Opportunity Hub is connected."
    });

    res.json({
      sent: true,
      message_id: result.result.message_id
    });
  } catch (error) {
    res.status(500).json({
      sent: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Create content
// ─────────────────────────────────────────────

app.post("/api/content", async (req, res) => {
  try {
    const {
      title,
      body,
      category = "AI Tools",
      source = "Manual",
      source_url = "",
      ai_score = 0
    } = req.body;

    if (!title || !body) {
      return res.status(400).json({
        error: "title and body are required"
      });
    }

    const duplicate = await pool.query(
      `
      SELECT id, title, status
      FROM content
      WHERE
        LOWER(title) = LOWER($1)
        OR (
          source_url <> ''
          AND source_url = $2
        )
      LIMIT 1
      `,
      [title.trim(), source_url]
    );

    if (duplicate.rows.length > 0) {
      return res.status(409).json({
        saved: false,
        duplicate: true,
        existing_content: duplicate.rows[0]
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
        ai_score,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'draft')
      RETURNING *
      `,
      [
        title.trim(),
        body.trim(),
        category,
        source,
        source_url,
        Number(ai_score) || 0
      ]
    );

    res.status(201).json({
      saved: true,
      content: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      saved: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Get content
// ─────────────────────────────────────────────

app.get("/api/content", async (req, res) => {
  try {
    const {
      category,
      status,
      limit = 50
    } = req.query;

    const values = [];
    const conditions = [];

    if (category) {
      values.push(category);
      conditions.push(`category = $${values.length}`);
    }

    if (status) {
      values.push(status);
      conditions.push(`status = $${values.length}`);
    }

    const safeLimit = Math.min(
      Math.max(parseInt(limit, 10) || 50, 1),
      100
    );

    values.push(safeLimit);

    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

    const result = await pool.query(
      `
      SELECT *
      FROM content
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${values.length}
      `,
      values
    );

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
// Get one content item
// ─────────────────────────────────────────────

app.get("/api/content/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM content
      WHERE id = $1
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Content not found"
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Update content
// ─────────────────────────────────────────────

app.patch("/api/content/:id", async (req, res) => {
  try {
    const {
      title,
      body,
      category,
      source,
      source_url,
      ai_score,
      status
    } = req.body;

    const result = await pool.query(
      `
      UPDATE content
      SET
        title = COALESCE($1, title),
        body = COALESCE($2, body),
        category = COALESCE($3, category),
        source = COALESCE($4, source),
        source_url = COALESCE($5, source_url),
        ai_score = COALESCE($6, ai_score),
        status = COALESCE($7, status)
      WHERE id = $8
      RETURNING *
      `,
      [
        title ?? null,
        body ?? null,
        category ?? null,
        source ?? null,
        source_url ?? null,
        ai_score !== undefined
          ? Number(ai_score)
          : null,
        status ?? null,
        req.params.id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Content not found"
      });
    }

    res.json({
      updated: true,
      content: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      updated: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Mark content as published
// ─────────────────────────────────────────────

app.patch("/api/content/:id/published", async (req, res) => {
  try {
    const {
      telegram_message_id
    } = req.body;

    const result = await pool.query(
      `
      UPDATE content
      SET
        status = 'published',
        telegram_message_id = $1,
        published_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
      `,
      [
        telegram_message_id
          ? Number(telegram_message_id)
          : null,
        req.params.id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Content not found"
      });
    }

    res.json({
      published: true,
      content: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      published: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Publish content to Telegram
// ─────────────────────────────────────────────

app.post("/api/content/:id/publish", async (req, res) => {
  try {
    if (!CHANNEL_USERNAME) {
      return res.status(500).json({
        error: "TELEGRAM_CHANNEL_USERNAME is not configured"
      });
    }

    const contentResult = await pool.query(
      `
      SELECT *
      FROM content
      WHERE id = $1
      `,
      [req.params.id]
    );

    if (contentResult.rows.length === 0) {
      return res.status(404).json({
        error: "Content not found"
      });
    }

    const content = contentResult.rows[0];

    if (content.status === "published") {
      return res.status(409).json({
        error: "Content has already been published",
        telegram_message_id:
          content.telegram_message_id
      });
    }

    const message =
      `🤖 ${content.title}\n\n` +
      `${content.body}\n\n` +
      `📌 ${content.category}`;

    const result = await telegram("sendMessage", {
      chat_id: CHANNEL_USERNAME,
      text: message,
      disable_web_page_preview: false
    });

    const updated = await pool.query(
      `
      UPDATE content
      SET
        status = 'published',
        telegram_message_id = $1,
        published_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
      `,
      [
        result.result.message_id,
        content.id
      ]
    );

    res.json({
      published: true,
      channel: CHANNEL_USERNAME,
      telegram_message_id:
        result.result.message_id,
      content: updated.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      published: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Browser publishing test
// ─────────────────────────────────────────────

app.get("/publish-test/:id", async (req, res) => {
  try {
    if (!CHANNEL_USERNAME) {
      return res.status(500).json({
        error: "TELEGRAM_CHANNEL_USERNAME is not configured"
      });
    }

    const contentResult = await pool.query(
      `
      SELECT *
      FROM content
      WHERE id = $1
      `,
      [req.params.id]
    );

    if (contentResult.rows.length === 0) {
      return res.status(404).json({
        error: "Content not found"
      });
    }

    const content = contentResult.rows[0];

    if (content.status === "published") {
      return res.status(409).json({
        error: "Content has already been published",
        telegram_message_id:
          content.telegram_message_id
      });
    }

    const message =
      `🤖 ${content.title}\n\n` +
      `${content.body}\n\n` +
      `📌 ${content.category}`;

    const result = await telegram("sendMessage", {
      chat_id: CHANNEL_USERNAME,
      text: message,
      disable_web_page_preview: false
    });

    const updated = await pool.query(
      `
      UPDATE content
      SET
        status = 'published',
        telegram_message_id = $1,
        published_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
      `,
      [
        result.result.message_id,
        content.id
      ]
    );

    res.json({
      published: true,
      channel: CHANNEL_USERNAME,
      telegram_message_id:
        result.result.message_id,
      content: updated.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      published: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Get sources
// ─────────────────────────────────────────────

app.get("/api/sources", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM sources
      ORDER BY name ASC
    `);

    res.json({
      count: result.rows.length,
      sources: result.rows
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Add source
// ─────────────────────────────────────────────

app.post("/api/sources", async (req, res) => {
  try {
    const {
      name,
      url,
      category = "General",
      reliability = 50
    } = req.body;

    if (!name || !url) {
      return res.status(400).json({
        error: "name and url are required"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO sources (
        name,
        url,
        category,
        reliability
      )
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [
        name.trim(),
        url.trim(),
        category,
        Number(reliability) || 50
      ]
    );

    res.status(201).json({
      saved: true,
      source: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      saved: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// Collect all active sources
// ─────────────────────────────────────────────

app.get("/api/collect", async (req, res) => {
  try {
    const sourceResult = await pool.query(`
      SELECT *
      FROM sources
      WHERE active = 1
      ORDER BY id ASC
    `);

    const results = [];

    for (const source of sourceResult.rows) {
      try {
        const result = await collectSource(source);

        results.push({
          success: true,
          ...result
        });
      } catch (error) {
        results.push({
          success: false,
          source_id: source.id,
          source: source.name,
    
