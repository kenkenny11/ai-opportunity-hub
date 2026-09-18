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

  const parsed = JSON.parse(
    raw.replace(/^\`\`\`json\s*/i, "").replace(/\s*\`\`\`$/i, "")
  );

  return {
    score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
    category: parsed.category || "AI News",
    reason: parsed.reason || "AI quality evaluation completed.",
    publishable: Boolean(parsed.publishable)
  };
}

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

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, () => {
  
      console.log(
        `AI Opportunity Hub running on port ${PORT}`
      );
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
