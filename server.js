import express from "express";
import pg from "pg";
import * as cheerio from "cheerio";

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TEST_CHAT_ID = process.env.TELEGRAM_TEST_CHAT_ID;
const CHANNEL_USERNAME = process.env.TELEGRAM_CHANNEL_USERNAME;
const DATABASE_URL = process.env.DATABASE_URL;
const AFFILIATE_ADMIN_KEY = process.env.AFFILIATE_ADMIN_KEY;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initializeDatabase() {
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
    CREATE TABLE IF NOT EXISTS affiliate_clicks (
      id SERIAL PRIMARY KEY,
      affiliate_id INTEGER NOT NULL,
      content_id INTEGER,
      clicked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

  await pool.query(`
    ALTER TABLE affiliate
    ADD COLUMN IF NOT EXISTS keywords TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS disclosure TEXT DEFAULT 'Affiliate link'
  `);

  const additionalSources = [
    {
      name: "Product Hunt",
      url: "https://www.producthunt.com/",
      category: "Digital Opportunities",
      reliability: 85
    },
    {
      name: "Wellfound AI & Startup Jobs",
      url: "https://wellfound.com/remote",
      category: "AI Jobs",
      reliability: 90
    }
  ];

  for (const source of additionalSources) {
    await pool.query(
      `INSERT INTO sources (name, url, category, active, reliability)
       SELECT $1, $2, $3, 1, $4
       WHERE NOT EXISTS (
         SELECT 1 FROM sources WHERE LOWER(name) = LOWER($1)
       )`,
      [
        source.name,
        source.url,
        source.category,
        source.reliability
      ]
    );
  }

  console.log("Database initialized");
}

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
    throw new Error(
      data.description || "Telegram API request failed"
    );
  }

  return data;
}

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.text();
}

function extractArticles(html, sourceUrl) {
  const $ = cheerio.load(html);
  const articles = [];
  const seen = new Set();
  const sourceHost = new URL(sourceUrl).hostname.toLowerCase();

  const blockedText = [
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
    "menu",
    "documentation",
    "official documentation",
    "architecture & optimization",
    "programming languages & frameworks",
    "how we use github to be more productive, collaborative, and secure"
  ];

  const blockedPathParts = [
    "/author/",
    "/authors/",
    "/category/",
    "/categories/",
    "/tag/",
    "/tags/",
    "/search",
    "/login",
    "/signin",
    "/signup",
    "/about/",
    "/careers/",
    "/docs/",
    "/documentation/"
  ];

  function cleanTitle(value) {
    let title = value
      .replace(/\\s+/g, " ")
      .trim();

    if (title.includes(" • ")) {
      title = title.split(" • ")[0].trim();
    }

    const metadataMarkers = [
      " • 1 day ago",
      " • 2 days ago",
      " • 3 days ago",
      " • 4 days ago",
      " • 5 days ago",
      " • 6 days ago",
      " • 7 days ago",
      " • 8 days ago",
      " • 9 days ago",
      " • 10 days ago",
      " • Jan ",
      " • Feb ",
      " • Mar ",
      " • Apr ",
      " • May ",
      " • Jun ",
      " • Jul ",
      " • Aug ",
      " • Sep ",
      " • Oct ",
      " • Nov ",
      " • Dec "
    ];

    for (const metadataMarker of metadataMarkers) {
      const markerIndex = title.indexOf(metadataMarker);
      if (markerIndex > 0) {
        title = title.slice(0, markerIndex).trim();
        break;
      }
    }

    if (title.includes(" | ")) {
      const parts = title.split(" | ");
      if (parts.length > 1 && parts[0].length >= 25) {
        title = parts[0].trim();
      }
    }

    return title;
  }

  function isLikelyArticle(url, title) {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const lowerTitle = title.toLowerCase();

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    if (blockedPathParts.some((part) => path.includes(part))) {
      return false;
    }

    if (blockedText.some((word) => lowerTitle === word || lowerTitle.includes(word))) {
      return false;
    }

    if (sourceHost.includes("github.blog")) {
      if (!path.startsWith("/ai-and-ml/")) {
        return false;
      }

      if (
        path.includes("/github-copilot/") ||
        path.includes("/generative-ai/") ||
        path.includes("/llms/")
      ) {
        return true;
      }

      return path.split("/").filter(Boolean).length >= 2;
    }

    if (sourceHost.includes("blogs.microsoft.com")) {
      if (path.includes("/blog/author/")) {
        return false;
      }

      const microsoftBlockedPhrases = [
        "company transformation",
        "achieving success with ai",
        "water intensity",
        "scientific discovery",
        "datacenter in",
        "our commitment",
        "our latest",
        "our company"
      ];

      if (
        microsoftBlockedPhrases.some((phrase) =>
          lowerTitle.includes(phrase)
        )
      ) {
        return false;
      }

      const parts = parsed.pathname.split("/").filter(Boolean);
      const year = parts[1];
      const month = parts[2];
      const day = parts[3];

      const isMicrosoftArticle =
        parts.length >= 4 &&
        parts[0] === "blog" &&
        year &&
        year.length === 4 &&
        month &&
        month.length === 2 &&
        day &&
        day.length === 2 &&
        !Number.isNaN(Number(year)) &&
        !Number.isNaN(Number(month)) &&
        !Number.isNaN(Number(day));

      return isMicrosoftArticle;
    }

    if (sourceHost.includes("huggingface.co")) {
      return path.startsWith("/blog/") && path.split("/").filter(Boolean).length >= 3;
    }

    if (sourceHost.includes("blog.google")) {
      return path.includes("/innovation-and-ai/");
    }

    if (sourceHost.includes("anthropic.com")) {
      return path.startsWith("/news/") && path.split("/").filter(Boolean).length >= 2;
    }

    return true;
  }

  $("a").each((index, element) => {
    if (articles.length >= 15) {
      return;
    }

    const href = $(element).attr("href");
    const headingText = $(element)
      .find("h1, h2, h3, h4, h5, h6")
      .first()
      .text();
    const rawText = headingText || $(element).text();

    if (!href || !rawText) {
      return;
    }

    const text = cleanTitle(rawText);

    if (text.length < 25 || text.length > 250) {
      return;
    }

    let absoluteUrl;

    try {
      absoluteUrl = new URL(href, sourceUrl).href;
    } catch {
      return;
    }

    if (!isLikelyArticle(absoluteUrl, text)) {
      return;
    }

    const canonicalUrl = absoluteUrl.split("#")[0];

    if (seen.has(canonicalUrl)) {
      return;
    }

    seen.add(canonicalUrl);

    articles.push({
      title: text,
      url: canonicalUrl
    });
  });

  return articles;
}

async function isDuplicate(title, url) {
  const result = await pool.query(
    `
      SELECT id
      FROM content
      WHERE LOWER(title) = LOWER($1)
         OR source_url = $2
      LIMIT 1
    `,
    [title, url]
  );

  return result.rows.length > 0;
}

async function collectSource(source) {
  const html = await fetchPage(source.url);

  const articles = extractArticles(
    html,
    source.url
  );

  let saved = 0;
  let duplicates = 0;

  for (const article of articles) {
    if (
      await isDuplicate(
        article.title,
        article.url
      )
    ) {
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
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        article.title,
        `Collected from ${source.name}. Waiting for AI processing.`,
        source.category || "AI News",
        source.name,
        article.url,
        0,
        "draft"
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

app.get("/", (req, res) => {
  res.json({
    service: "AI Opportunity Hub",
    status: "online",
    database: "Neon PostgreSQL",
    collector: "ready"
  });
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      service: "AI Opportunity Hub",
      database: "connected",
      telegram: BOT_TOKEN
        ? "configured"
        : "missing"
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      database: "disconnected",
      error: error.message
    });
  }
});

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

app.get("/send-test", async (req, res) => {
  try {
    if (!TEST_CHAT_ID) {
      return res.status(500).json({
        error:
          "TELEGRAM_TEST_CHAT_ID is not configured"
      });
    }

    const result = await telegram(
      "sendMessage",
      {
        chat_id: TEST_CHAT_ID,
        text:
          "🤖 AI Opportunity Hub is connected."
      }
    );

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
        WHERE LOWER(title) = LOWER($1)
           OR (
             source_url <> ''
             AND source_url = $2
           )
        LIMIT 1
      `,
      [
        title.trim(),
        source_url
      ]
    );

    if (duplicate.rows.length > 0) {
      return res.status(409).json({
        saved: false,
        duplicate: true,
        existing_content:
          duplicate.rows[0]
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
      conditions.push(
        `category = $${values.length}`
      );
    }

    if (status) {
      values.push(status);
      conditions.push(
        `status = $${values.length}`
      );
    }

    const safeLimit = Math.min(
      Math.max(
        parseInt(limit, 10) || 50,
        1
      ),
      100
    );

    values.push(safeLimit);

    const where =
      conditions.length > 0
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

    const result = await pool.query(
      `
        SELECT *
        FROM content
        ${where}
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

app.post(
  "/api/content/:id/publish",
  async (req, res) => {
    try {
      if (!CHANNEL_USERNAME) {
        return res.status(500).json({
          error: "TELEGRAM_CHANNEL_USERNAME is not configured"
        });
      }

      const result = await pool.query(
        "SELECT * FROM content WHERE id = $1 LIMIT 1",
        [req.params.id]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: "Content not found" });
      }

      const content = result.rows[0];

      if (content.status === "published") {
        return res.status(409).json({
          error: "Content has already been published",
          telegram_message_id: content.telegram_message_id
        });
      }

      if (Number(content.ai_score) < 75) {
        return res.status(400).json({
          published: false,
          error: "Content is below the publishable AI score threshold of 75",
          score: Number(content.ai_score)
        });
      }

      if (!content.body || content.body.startsWith("Collected from ")) {
        return res.status(400).json({
          published: false,
          error: "AI-generated content is required before publishing"
        });
      }

      const telegramResult = await telegram("sendMessage", {
        chat_id: CHANNEL_USERNAME,
        text: content.body,
        disable_web_page_preview: false
      });

      const updated = await pool.query(
        `UPDATE content
         SET status = 'published',
             telegram_message_id = $1,
             published_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING *`,
        [telegramResult.result.message_id, content.id]
      );

      res.json({
        published: true,
        channel: CHANNEL_USERNAME,
        telegram_message_id: telegramResult.result.message_id,
        content: updated.rows[0]
      });
    } catch (error) {
      console.error("Publishing error:", error);
      res.status(500).json({
        published: false,
        error: error.message
      });
    }
  }
);


app.get("/api/ai/publish/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM content WHERE id = $1 LIMIT 1",
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Content not found" });
    }

    const content = result.rows[0];

    if (content.status === "published") {
      return res.status(409).json({
        published: false,
        error: "Content has already been published",
        telegram_message_id: content.telegram_message_id
      });
    }

    if (Number(content.ai_score) < 75) {
      return res.status(400).json({
        published: false,
        error: "Content is below the publishable AI score threshold of 75",
        score: Number(content.ai_score)
      });
    }

    if (!content.body || content.body.startsWith("Collected from ")) {
      return res.status(400).json({
        published: false,
        error: "AI-generated content is required before publishing"
      });
    }

    const telegramResult = await telegram("sendMessage", {
      chat_id: CHANNEL_USERNAME,
      text: content.body,
      disable_web_page_preview: false
    });

    const updated = await pool.query(
      `UPDATE content
       SET status = 'published',
           telegram_message_id = $1,
           published_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [telegramResult.result.message_id, content.id]
    );

    res.json({
      published: true,
      channel: CHANNEL_USERNAME,
      telegram_message_id: telegramResult.result.message_id,
      content: updated.rows[0]
    });
  } catch (error) {
    console.error("Auto-publish error:", error);
    res.status(500).json({
      published: false,
      error: error.message
    });
  }
});

app.get(
  "/publish-test/:id",
  async (req, res) => {
    try {
      if (!CHANNEL_USERNAME) {
        return res.status(500).json({
          error:
            "TELEGRAM_CHANNEL_USERNAME is not configured"
        });
      }

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

      const content = result.rows[0];

      if (content.status === "published") {
        return res.status(409).json({
          error:
            "Content has already been published",
          telegram_message_id:
            content.telegram_message_id
        });
      }

      const message =
        `🤖 ${content.title}\n\n` +
        `${content.body}\n\n` +
        `📌 ${content.category}`;

      const telegramResult = await telegram(
        "sendMessage",
        {
          chat_id: CHANNEL_USERNAME,
          text: message
        }
      );

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
          telegramResult.result.message_id,
          content.id
        ]
      );

      res.json({
        published: true,
        channel: CHANNEL_USERNAME,
        telegram_message_id:
          telegramResult.result.message_id,
        content: updated.rows[0]
      });
    } catch (error) {
      res.status(500).json({
        published: false,
        error: error.message
      });
    }
  }
);


app.get("/api/affiliate", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        a.*,
        COUNT(ac.id)::int AS click_count
      FROM affiliate a
      LEFT JOIN affiliate_clicks ac ON ac.affiliate_id = a.id
      GROUP BY a.id
      ORDER BY a.active DESC, a.id DESC
    `);

    res.json({
      count: result.rows.length,
      affiliates: result.rows
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.get("/go/affiliate/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM affiliate
       WHERE id = $1 AND active = 1
       LIMIT 1`,
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).send("Affiliate link not found");
    }

    const affiliate = result.rows[0];
    const target = String(affiliate.affiliate_url || "");

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return res.status(400).send("Invalid affiliate URL");
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).send("Invalid affiliate URL");
    }

    const contentId = Number(req.query.content_id) || null;

    await pool.query(
      `INSERT INTO affiliate_clicks (affiliate_id, content_id)
       VALUES ($1, $2)`,
      [affiliate.id, contentId]
    );

    if (contentId) {
      await pool.query(
        `INSERT INTO analytics (content_id, clicks, ctr)
         VALUES ($1, 1, 0)`,
        [contentId]
      );
    }

    res.redirect(target);
  } catch (error) {
    console.error("Affiliate redirect error:", error);
    res.status(500).send("Unable to process affiliate link");
  }
});

app.get("/api/affiliate/:id/stats", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         a.id,
         a.product,
         a.company,
         a.active,
         COUNT(ac.id)::int AS clicks
       FROM affiliate a
       LEFT JOIN affiliate_clicks ac ON ac.affiliate_id = a.id
       WHERE a.id = $1
       GROUP BY a.id
       LIMIT 1`,
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Affiliate not found"
      });
    }

    res.json({
      affiliate: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

function requireAffiliateAdmin(req, res) {
  if (!AFFILIATE_ADMIN_KEY) {
    res.status(503).json({
      error: "AFFILIATE_ADMIN_KEY is not configured"
    });
    return false;
  }

  const providedKey = req.get("x-affiliate-admin-key");

  if (!providedKey || providedKey !== AFFILIATE_ADMIN_KEY) {
    res.status(401).json({
      error: "Unauthorized"
    });
    return false;
  }

  return true;
}

app.post("/api/affiliate", async (req, res) => {
  try {
    if (!requireAffiliateAdmin(req, res)) return;

    const {
      product,
      company,
      url = "",
      affiliate_url,
      commission = "",
      keywords = "",
      disclosure = "Affiliate link",
      active = 1
    } = req.body;

    if (!product || !company || !affiliate_url) {
      return res.status(400).json({
        error: "product, company and affiliate_url are required"
      });
    }

    let parsed;
    try {
      parsed = new URL(affiliate_url);
    } catch {
      return res.status(400).json({
        error: "affiliate_url must be a valid URL"
      });
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({
        error: "affiliate_url must use http or https"
      });
    }

    const result = await pool.query(
      `INSERT INTO affiliate (
        product,
        company,
        url,
        affiliate_url,
        commission,
        keywords,
        disclosure,
        active
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [
        product.trim(),
        company.trim(),
        String(url || "").trim(),
        affiliate_url.trim(),
        String(commission || "").trim(),
        String(keywords || "").trim(),
        String(disclosure || "Affiliate link").trim(),
        Number(active) ? 1 : 0
      ]
    );

    res.status(201).json({
      saved: true,
      affiliate: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      saved: false,
      error: error.message
    });
  }
});

app.patch("/api/affiliate/:id", async (req, res) => {
  try {
    if (!requireAffiliateAdmin(req, res)) return;

    const {
      product,
      company,
      url,
      affiliate_url,
      commission,
      keywords,
      disclosure,
      active
    } = req.body;

    if (affiliate_url !== undefined) {
      let parsed;
      try {
        parsed = new URL(String(affiliate_url));
      } catch {
        return res.status(400).json({
          error: "affiliate_url must be a valid URL"
        });
      }

      if (!["http:", "https:"].includes(parsed.protocol)) {
        return res.status(400).json({
          error: "affiliate_url must use http or https"
        });
      }
    }

    const result = await pool.query(
      `UPDATE affiliate
       SET
         product = COALESCE($1, product),
         company = COALESCE($2, company),
         url = COALESCE($3, url),
         affiliate_url = COALESCE($4, affiliate_url),
         commission = COALESCE($5, commission),
         keywords = COALESCE($6, keywords),
         disclosure = COALESCE($7, disclosure),
         active = COALESCE($8, active)
       WHERE id = $9
       RETURNING *`,
      [
        product ?? null,
        company ?? null,
        url ?? null,
        affiliate_url ?? null,
        commission ?? null,
        keywords ?? null,
        disclosure ?? null,
        active === undefined ? null : (Number(active) ? 1 : 0),
        req.params.id
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Affiliate not found"
      });
    }

    res.json({
      updated: true,
      affiliate: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      updated: false,
      error: error.message
    });
  }
});

app.delete("/api/affiliate/:id", async (req, res) => {
  try {
    if (!requireAffiliateAdmin(req, res)) return;

    const result = await pool.query(
      "DELETE FROM affiliate WHERE id = $1 RETURNING id",
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Affiliate not found"
      });
    }

    res.json({
      deleted: true,
      id: result.rows[0].id
    });
  } catch (error) {
    res.status(500).json({
      deleted: false,
      error: error.message
    });
  }
});

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
        error:
          "name and url are required"
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

async function scoreContentWithAI(content) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const prompt = `You are the quality editor for AI Opportunity Hub, a Telegram channel about useful AI tools, jobs, digital opportunities, Android/AI apps, tutorials, AI news, and free resources.

Evaluate this candidate:
Title: ${content.title}
Source: ${content.source}
URL: ${content.source_url || ""}

Return ONLY valid JSON:
{"score":0,"category":"AI News","reason":"short factual reason","publishable":false}

Score using: usefulness 25, relevance 20, freshness 20, engagement potential 15, monetization potential 10, source quality 10.
Set publishable=true only when score >= 75. Do not invent facts.`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://ai-opportunity-hub.onrender.com",
      "X-Title": "AI Opportunity Hub"
    },
    body: JSON.stringify({
      model: "openai/gpt-4.1-mini",
      messages: [
        { role: "system", content: "Return JSON only. No markdown." },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 300
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter HTTP ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim();

  if (!raw) throw new Error("OpenRouter returned no content");

  const cleaned = raw
    .replace(/^\`\`\`json\s*/i, "")
    .replace(/\s*\`\`\`$/i, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const repaired = cleaned
      .replace(/"score"\s*:\s*seventy\b/gi, '"score": 70')
      .replace(/"score"\s*:\s*eighty\b/gi, '"score": 80')
      .replace(/"score"\s*:\s*sixty\b/gi, '"score": 60')
      .replace(/"score"\s*:\s*fifty\b/gi, '"score": 50')
      .replace(/"score"\s*:\s*ninety\b/gi, '"score": 90')
      .replace(/"score"\s*:\s*one hundred\b/gi, '"score": 100');
    parsed = JSON.parse(repaired);
  }

  const allowedCategories = [
    "AI Tools",
    "AI Jobs",
    "Digital Opportunities",
    "Android & AI Apps",
    "AI Tutorials",
    "AI News",
    "Free Resources",
    "Tutorials"
  ];

  let score = Number(parsed.score);
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const category = allowedCategories.includes(parsed.category)
    ? parsed.category
    : "AI News";

  return {
    score,
    category,
    reason: parsed.reason || "AI quality evaluation completed.",
    publishable: score >= 75
  };
}



function cleanGeneratedPost(text) {
  return String(text || "")
    .replace(/^\s*\`\`\`(?:markdown|text)?\s*/i, "")
    .replace(/\s*\`\`\`\s*$/i, "")
    .trim();
}

async function generateContentWithAI(content) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const category = content.category || "AI News";

  let formatRules = "";

  if (category === "AI Jobs") {
    formatRules = `
JOB FORMAT:
- Clearly state the job/role if verified by the title.
- Mention company, location/remote status, and application details only when present in the verified information.
- Do not invent salary, requirements, visa support, or benefits.
- End with: "🔗 Apply: [source URL]"
`;
  } else if (category === "Digital Opportunities") {
    formatRules = `
OPPORTUNITY FORMAT:
- Clearly explain what the opportunity/product is from the verified information.
- Mention launch, access, pricing, or availability only when supported.
- Do not promise income, success, or business results.
- End with: "🔗 Source: [source URL]"
`;
  } else if (category === "AI Tools" || category === "Android & AI Apps") {
    formatRules = `
TOOL FORMAT:
- Explain what the tool/app is based only on the verified title and source.
- Mention platform, pricing, features, or access only when verified.
- Do not claim a tool is "best", "free", "unlimited", or "powerful" unless verified.
- End with: "🔗 Try it / Source: [source URL]"
`;
  } else if (category === "AI Tutorials" || category === "Tutorials") {
    formatRules = `
TUTORIAL FORMAT:
- Explain the topic and the practical idea covered by the source.
- Do not invent steps that are not supported by the source information.
- End with: "🔗 Read the tutorial: [source URL]"
`;
  } else if (category === "Free Resources") {
    formatRules = `
FREE RESOURCE FORMAT:
- Explain the resource and what is verified about its access.
- Do not claim something is free if the source information does not support it.
- End with: "🔗 Resource: [source URL]"
`;
  } else {
    formatRules = `
NEWS FORMAT:
- State what was announced using only verified information.
- Keep context factual and cautious.
- End with: "🔗 Source: [source URL]"
`;
  }

  const prompt = `Create a factual Telegram post for AI Opportunity Hub.

Title: ${content.title}
Source: ${content.source}
URL: ${content.source_url || ""}
Category: ${category}

Strict rules:
- Treat the title as the main verified claim.
- Do not invent or infer features, capabilities, performance, availability, pricing, legal rights, dates, user benefits, statistics, quotes, salary, requirements, or industry impact.
- Do not promise income, jobs, business results, or financial outcomes.
- Avoid promotional phrases such as "game-changing", "major boost", "revolutionary", "best", "guaranteed", "easy money", or "get rich".
- If source details are limited, keep the post short rather than filling gaps with assumptions.
- Keep it about 80-150 words.
- Start with a clear headline.
- End with one short engagement question.
- Use the exact source URL supplied above.
- Return ONLY the finished Telegram post.

${formatRules}`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://ai-opportunity-hub.onrender.com",
      "X-Title": "AI Opportunity Hub"
    },
    body: JSON.stringify({
      model: "openai/gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: "You write concise, factual Telegram posts. Never invent facts."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2,
      max_tokens: 500
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter HTTP ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;

  if (!raw) {
    throw new Error("OpenRouter returned no generated content");
  }

  return cleanGeneratedPost(raw);
}

async function addAffiliateTrackingToPost(post, content) {
  if (!post || !content) return post;

  const eligibleCategories = [
    "AI Tools",
    "Android & AI Apps",
    "Digital Opportunities"
  ];

  if (!eligibleCategories.includes(content.category)) {
    return post;
  }

  const { rows } = await pool.query(
    `SELECT *
     FROM affiliate
     WHERE active = 1
       AND affiliate_url IS NOT NULL
       AND affiliate_url <> ''
     ORDER BY id ASC`
  );

  const haystack = `${content.title} ${post}`.toLowerCase();

  for (const affiliate of rows) {
    const terms = String(
      affiliate.keywords || `${affiliate.product || ""} ${affiliate.company || ""}`
    )
      .split(/[,|]/)
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term.length >= 4);

    if (!terms.length) continue;

    const matched = terms.some((term) => haystack.includes(term));

    if (!matched) continue;

    const trackedUrl =
      `https://ai-opportunity-hub.onrender.com/go/affiliate/${affiliate.id}?content_id=${content.id}`;

    const disclosure = affiliate.disclosure || "Affiliate link";

    return `${post}\n\n🔗 ${affiliate.product || affiliate.company || "Recommended resource"}: ${trackedUrl}\nℹ️ ${disclosure}`;
  }

  return post;
}

app.get("/api/ai/generate/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM content WHERE id = $1 LIMIT 1",
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Content not found" });
    }

    const content = rows[0];

    if (Number(content.ai_score) < 75) {
      return res.status(400).json({
        generated: false,
        error: "Content is below the publishable AI score threshold of 75",
        score: Number(content.ai_score)
      });
    }

    let generatedPost = await generateContentWithAI(content);
    generatedPost = await addAffiliateTrackingToPost(generatedPost, content);

    await pool.query(
      "UPDATE content SET body = $1 WHERE id = $2",
      [generatedPost, req.params.id]
    );

    res.json({
      generated: true,
      id: content.id,
      title: content.title,
      score: Number(content.ai_score),
      category: content.category,
      body: generatedPost
    });
  } catch (error) {
    console.error("AI generation error:", error);
    res.status(500).json({ generated: false, error: error.message });
  }
});

app.post("/api/ai/generate/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM content WHERE id = $1 LIMIT 1",
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Content not found" });
    }

    const content = rows[0];

    if (Number(content.ai_score) < 75) {
      return res.status(400).json({
        generated: false,
        error: "Content is below the publishable AI score threshold of 75",
        score: Number(content.ai_score)
      });
    }

    const generatedPost = await generateContentWithAI(content);

    await pool.query(
      "UPDATE content SET body = $1 WHERE id = $2",
      [generatedPost, req.params.id]
    );

    res.json({
      generated: true,
      id: content.id,
      title: content.title,
      score: Number(content.ai_score),
      category: content.category,
      body: generatedPost
    });
  } catch (error) {
    console.error("AI generation error:", error);
    res.status(500).json({ generated: false, error: error.message });
  }
});

app.get("/api/ai/generate-drafts", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 25);

    const { rows } = await pool.query(
      `SELECT * FROM content
       WHERE status = 'draft'
         AND ai_score >= 75
       ORDER BY ai_score DESC, id DESC
       LIMIT $1`,
      [limit]
    );

    const results = [];

    for (const item of rows) {
      try {
        let generatedPost = await generateContentWithAI(item);
        generatedPost = await addAffiliateTrackingToPost(generatedPost, item);

        await pool.query(
          "UPDATE content SET body = $1 WHERE id = $2",
          [generatedPost, item.id]
        );

        results.push({
          id: item.id,
          title: item.title,
          score: Number(item.ai_score),
          category: item.category,
          generated: true,
          body: generatedPost
        });
      } catch (error) {
        results.push({
          id: item.id,
          title: item.title,
          generated: false,
          error: error.message
        });
      }
    }

    res.json({
      generated: true,
      count: results.length,
      results
    });
  } catch (error) {
    console.error("Draft generation error:", error);
    res.status(500).json({ generated: false, error: error.message });
  }
});

app.get("/api/ai/score/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM content WHERE id = $1 LIMIT 1",
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Content not found" });
    }

    const result = await scoreContentWithAI(rows[0]);

    await pool.query(
      "UPDATE content SET ai_score = $1, category = $2 WHERE id = $3",
      [result.score, result.category, req.params.id]
    );

    res.json({
      scored: true,
      id: rows[0].id,
      title: rows[0].title,
      score: result.score,
      category: result.category,
      publishable: result.publishable,
      reason: result.reason
    });
  } catch (error) {
    console.error("AI scoring error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/ai/score/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM content WHERE id = $1 LIMIT 1",
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Content not found" });
    }

    const result = await scoreContentWithAI(rows[0]);

    await pool.query(
      "UPDATE content SET ai_score = $1, category = $2 WHERE id = $3",
      [result.score, result.category, req.params.id]
    );

    res.json({
      scored: true,
      id: rows[0].id,
      title: rows[0].title,
      score: result.score,
      category: result.category,
      publishable: result.publishable,
      reason: result.reason
    });
  } catch (error) {
    console.error("AI scoring error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/ai/score-drafts", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 25);
    const { rows } = await pool.query(
      "SELECT * FROM content WHERE status = 'draft' ORDER BY id DESC LIMIT $1",
      [limit]
    );

    const results = [];

    for (const item of rows) {
      try {
        const result = await scoreContentWithAI(item);

        await pool.query(
          "UPDATE content SET ai_score = $1, category = $2 WHERE id = $3",
          [result.score, result.category, item.id]
        );

        results.push({
          id: item.id,
          title: item.title,
          score: result.score,
          category: result.category,
          publishable: result.publishable,
          reason: result.reason
        });
      } catch (error) {
        results.push({
          id: item.id,
          title: item.title,
          error: error.message
        });
      }
    }

    res.json({ scored: true, count: results.length, results });
  } catch (error) {
    console.error("Draft scoring error:", error);
    res.status(500).json({ error: error.message });
  }
});


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
          error: error.message
        });

        await pool.query(
          `
            UPDATE sources
            SET last_checked = CURRENT_TIMESTAMP
            WHERE id = $1
          `,
          [source.id]
        );
      }
    }

    const totalFound = results.reduce(
      (sum, item) =>
        sum + (item.found || 0),
      0
    );

    const totalSaved = results.reduce(
      (sum, item) =>
        sum + (item.saved || 0),
      0
    );

    res.json({
      collected: true,
      sources_checked:
        sourceResult.rows.length,
      total_found: totalFound,
      total_saved: totalSaved,
      results
    });
  } catch (error) {
    res.status(500).json({
      collected: false,
      error: error.message
    });
  }
});

app.get(
  "/api/collect/:sourceId",
  async (req, res) => {
    try {
      const result = await pool.query(
        `
          SELECT *
          FROM sources
          WHERE id = $1
        `,
        [req.params.sourceId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Source not found"
        });
      }

      const collected = await collectSource(
        result.rows[0]
      );

      res.json({
        collected: true,
        ...collected
      });
    } catch (error) {
      res.status(500).json({
        collected: false,
        error: error.message
      });
    }
  }
);

app.post("/api/analytics", async (req, res) => {
  try {
    const {
      content_id,
      views = 0,
      reactions = 0,
      comments = 0,
      clicks = 0,
      performance_score = 0
    } = req.body;

    if (!content_id) {
      return res.status(400).json({
        error: "content_id is required"
      });
    }

    const numericViews = Number(views) || 0;
    const numericClicks = Number(clicks) || 0;

    const ctr =
      numericViews > 0
        ? (numericClicks / numericViews) * 100
        : 0;

    const result = await pool.query(
      `
        INSERT INTO analytics (
          content_id,
          views,
          reactions,
          comments,
          clicks,
          ctr,
          performance_score
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `,
      [
        content_id,
        numericViews,
        Number(reactions) || 0,
        Number(comments) || 0,
        numericClicks,
        ctr,
        Number(performance_score) || 0
      ]
    );

    res.status(201).json({
      saved: true,
      analytics: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      saved: false,
      error: error.message
    });
  }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const totals = await pool.query(`
      SELECT
        COUNT(*)::int AS total_content,
        COUNT(*) FILTER (WHERE status = 'published')::int AS published,
        COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts,
        COUNT(*) FILTER (WHERE ai_score >= 75)::int AS approved
      FROM content
    `);

    const categories = await pool.query(`
      SELECT category, COUNT(*)::int AS count
      FROM content
      GROUP BY category
      ORDER BY count DESC
    `);

    const sources = await pool.query(`
      SELECT
        s.name,
        s.category,
        s.active,
        s.last_checked,
        COUNT(c.id)::int AS content_count
      FROM sources s
      LEFT JOIN content c ON c.source = s.name
      GROUP BY s.id, s.name, s.category, s.active, s.last_checked
      ORDER BY s.active DESC, content_count DESC
    `);

    const affiliateStats = await pool.query(`
      SELECT
        COUNT(*)::int AS affiliate_count,
        COUNT(*) FILTER (WHERE active = 1)::int AS active_affiliates,
        COALESCE((
          SELECT COUNT(*)::int
          FROM affiliate_clicks
        ), 0) AS affiliate_clicks
      FROM affiliate
    `);

    const recent = await pool.query(`
      SELECT id, title, category, ai_score, status, source, created_at, published_at
      FROM content
      ORDER BY id DESC
      LIMIT 20
    `);

    res.json({
      dashboard: true,
      totals: totals.rows[0],
      categories: categories.rows,
      sources: sources.rows,
      affiliates: affiliateStats.rows[0],
      recent: recent.rows
    });
  } catch (error) {
    res.status(500).json({
      dashboard: false,
      error: error.message
    });
  }
});

app.get(
  "/api/analytics/:contentId",
  async (req, res) => {
    try {
      const result = await pool.query(
        `
          SELECT *
          FROM analytics
          WHERE content_id = $1
          ORDER BY recorded_at DESC
        `,
        [req.params.contentId]
      );

      res.json({
        count: result.rows.length,
        analytics: result.rows
      });
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }
);

async function runAutomationCycle() {
  console.log("Starting automation cycle...");

  try {
    const collectResponse = await fetch(
      `http://127.0.0.1:${PORT}/api/collect`
    );
    const collectResult = await collectResponse.json();
    console.log("Collector:", collectResult.total_saved ?? collectResult.error);

    const scoreResult = await pool.query(
      `SELECT *
       FROM content
       WHERE status = 'draft'
         AND (ai_score IS NULL OR ai_score = 0)
       ORDER BY id DESC
       LIMIT 10`
    );

    let scored = 0;
    for (const content of scoreResult.rows) {
      try {
        const evaluation = await scoreContentWithAI(content);

        await pool.query(
          `UPDATE content
           SET ai_score = $1,
               category = $2
           WHERE id = $3`,
          [evaluation.score, evaluation.category, content.id]
        );

        scored++;
        console.log(`Scored #${content.id}: ${evaluation.score}`);
      } catch (error) {
        console.error(`Scoring #${content.id} failed:`, error.message);
      }
    }

    const generateResult = await pool.query(
      `SELECT *
       FROM content
       WHERE status = 'draft'
         AND ai_score >= 75
         AND (body IS NULL OR body = '' OR body LIKE 'Collected from %')
       ORDER BY ai_score DESC, id DESC
       LIMIT 5`
    );

    let generated = 0;
    for (const content of generateResult.rows) {
      try {
        let post = await generateContentWithAI(content);
        post = await addAffiliateTrackingToPost(post, content);

        await pool.query(
          "UPDATE content SET body = $1 WHERE id = $2",
          [post, content.id]
        );

        generated++;
        console.log(`Generated #${content.id}`);
      } catch (error) {
        console.error(`Generation #${content.id} failed:`, error.message);
      }
    }

    const publishResult = await pool.query(
      `SELECT *
       FROM content
       WHERE status = 'draft'
         AND ai_score >= 75
         AND body IS NOT NULL
         AND body <> ''
         AND body NOT LIKE 'Collected from %'
       ORDER BY ai_score DESC, id DESC
       LIMIT 3`
    );

    let published = 0;
    for (const content of publishResult.rows) {
      try {
        const telegramResult = await telegram("sendMessage", {
          chat_id: CHANNEL_USERNAME,
          text: content.body,
          disable_web_page_preview: false
        });

        await pool.query(
          `UPDATE content
           SET status = 'published',
               telegram_message_id = $1,
               published_at = CURRENT_TIMESTAMP
           WHERE id = $2
             AND status = 'draft'`,
          [telegramResult.result.message_id, content.id]
        );

        published++;
        console.log(
          `Published #${content.id} as Telegram message ${telegramResult.result.message_id}`
        );
      } catch (error) {
        console.error(`Publishing #${content.id} failed:`, error.message);
      }
    }

    console.log(
      `Automation complete: scored=${scored}, generated=${generated}, published=${published}`
    );

    return {
      collected: collectResult,
      scored,
      generated,
      published
    };
  } catch (error) {
    console.error("Automation cycle failed:", error);
    return {
      scored: 0,
      generated: 0,
      published: 0,
      error: error.message
    };
  }
}

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, () => {
      console.log(
        `AI Opportunity Hub running on port ${PORT}`
      );

      setTimeout(() => {
        runAutomationCycle();
      }, 15000);

      setInterval(() => {
        runAutomationCycle();
      }, 30 * 60 * 1000);
    });
  } catch (error) {
    console.error(
      "Failed to start server:",
      error
    );
    process.exit(1);
  }
}

startServer();