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
const ADMIN_DASHBOARD_KEY = process.env.ADMIN_DASHBOARD_KEY;

function requireAdmin(req, res, next) {
  if (!ADMIN_DASHBOARD_KEY) {
    return res.status(503).json({ error: "ADMIN_DASHBOARD_KEY is not configured" });
  }

  const provided = req.get("x-admin-key") || req.query.admin_key;
  if (provided !== ADMIN_DASHBOARD_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}


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
    CREATE TABLE IF NOT EXISTS premium_products (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      price_stars INTEGER NOT NULL DEFAULT 50,
      content TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const premiumCheck = await pool.query(
    "SELECT id FROM premium_products WHERE title = $1 LIMIT 1",
    ["AI Opportunity Starter Pack"]
  );
  if (premiumCheck.rowCount === 0) {
    await pool.query(`
      INSERT INTO premium_products (title, description, price_stars, content, active)
      VALUES (
        'AI Opportunity Starter Pack',
        'A practical starter pack for finding, evaluating and using AI tools and opportunities.',
        50,
        'AI OPPORTUNITY STARTER PACK

1. TOOL CHECKLIST
- Verify the official website before signing up.
- Check pricing, free-tier limits and privacy terms.
- Test one small workflow before committing time or money.

2. OPPORTUNITY CHECKLIST
- Confirm the source and closing date.
- Check location and eligibility requirements.
- Never pay a fee just to apply for a job.

3. AI WORKFLOW
- Research -> verify -> score -> publish -> measure.
- Keep source URLs with every published item.
- Review engagement before repeating a topic.

4. CONTENT FORMULA
Hook -> verified fact -> practical use -> source -> question.

This starter pack is delivered digitally through AI Opportunity Hub after payment.',
        1
      )
    `);
  }


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

  await pool.query(
    `INSERT INTO affiliate (
      product, company, url, affiliate_url, commission, keywords, disclosure, active
    )
    SELECT
      'Twin',
      'Twin',
      'https://twin.so/',
      'https://twin.so/?via=AIOpportunityHub',
      '20% recurring for 12 months',
      'twin, ai automation, automation',
      'Affiliate link',
      1
    WHERE NOT EXISTS (
      SELECT 1 FROM affiliate WHERE LOWER(company) = 'twin'
    )`
  );

  await pool.query(
    `INSERT INTO affiliate (
      product, company, url, affiliate_url, commission, keywords, disclosure, active
    )
    SELECT
      'Vidpal',
      'Vidpal',
      'https://www.vidpal.ai/',
      'https://vidpal.ai/?atp=AIOpportunityHub',
      '30% recurring for life',
      'vidpal, ai video, ai reels, video automation, content automation',
      'Affiliate link',
      1
    WHERE NOT EXISTS (
      SELECT 1 FROM affiliate WHERE LOWER(company) = 'vidpal'
    )`
  );

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

    const normalizedSource = sourceHost;
    const lowerText = text.toLowerCase();

    if (normalizedSource.includes("wellfound.com")) {
      const aiSignals = [
        "ai", "artificial intelligence", "machine learning", "ml ",
        "deep learning", "llm", "generative", "genai", "computer vision",
        "nlp", "natural language", "robotics", "autonomous", "data science",
        "data scientist", "ml engineer", "machine learning engineer",
        "ai engineer", "ai platform", "applied ai", "machine intelligence"
      ];

      const hasAiSignal = aiSignals.some((signal) => lowerText.includes(signal));

      if (!hasAiSignal) {
        return;
      }
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


// Safely reject old low-score drafts without modifying the dashboard HTML.
app.post("/api/admin/cleanup-rejected", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("UPDATE content SET status = 'rejected' WHERE status = 'draft' AND COALESCE(ai_score, 0) <= 20 AND category <> 'Digital Opportunities' RETURNING id");
    res.json({ cleaned: result.rowCount, ids: result.rows.map(r => r.id) });
  } catch (error) {
    console.error("Cleanup rejected error:", error);
    res.status(500).json({ error: "Failed to clean rejected drafts" });
  }
});


// Browser-friendly one-time cleanup route; protected by the same admin key.
app.get("/api/admin/cleanup-rejected", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("UPDATE content SET status = 'rejected' WHERE status = 'draft' AND COALESCE(ai_score, 0) <= 20 AND category <> 'Digital Opportunities' RETURNING id");
    res.json({ cleaned: result.rowCount, ids: result.rows.map(r => r.id) });
  } catch (error) {
    console.error("Cleanup rejected error:", error);
    res.status(500).json({ error: "Failed to clean rejected drafts" });
  }
});
app.get("/admin", (req, res) => {
  res.type("html").send("<!doctype html>\n<html lang=\"en\"><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>AI Opportunity Hub Admin</title>\n<style>\n:root{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f7fb;color:#10233f}\n*{box-sizing:border-box}body{margin:0}.top{background:#0b63ce;color:#fff;padding:20px 16px;position:sticky;top:0;z-index:5}\nh1{font-size:22px;margin:0 0 4px}.muted{opacity:.8;font-size:13px}main{max-width:900px;margin:auto;padding:14px}\n.card{background:#fff;border-radius:16px;padding:16px;margin:12px 0;box-shadow:0 3px 14px #10233f14}\n.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.stat{padding:14px;border:1px solid #e2eaf4;border-radius:12px}.num{font-size:25px;font-weight:800}\ninput{width:100%;padding:12px;border:1px solid #ccd8e7;border-radius:10px;margin:7px 0 10px;font-size:15px}\nbutton{border:0;border-radius:10px;padding:11px 14px;font-weight:700;cursor:pointer;margin:4px 4px 4px 0;background:#0b63ce;color:#fff}\nbutton.secondary{background:#e8f1fc;color:#0b63ce}button.danger{background:#c62828}.item{border-top:1px solid #edf1f6;padding:13px 0}.item:first-child{border-top:0}\n.badge{display:inline-block;border-radius:20px;padding:4px 8px;font-size:12px;background:#edf4ff;color:#0b63ce;margin:3px 3px 3px 0}\n.post{white-space:pre-wrap;background:#f7f9fc;border-radius:10px;padding:12px;margin-top:8px;font-size:14px}\n.ok{color:#16803c}.err{color:#c62828}@media(min-width:700px){.grid{grid-template-columns:repeat(4,1fr)}}\n</style></head>\n<body><header class=\"top\"><h1>🤖 AI Opportunity Hub</h1><div class=\"muted\">Mobile Admin Dashboard</div></header>\n<main>\n<section class=\"card\"><strong>Admin access</strong><input id=\"key\" type=\"password\" placeholder=\"Enter dashboard admin key\">\n<button onclick=\"saveKey()\">Save key</button><button class=\"secondary\" onclick=\"loadAll()\">Refresh</button><div id=\"msg\" class=\"muted\"></div></section>\n<section class=\"card\"><div id=\"stats\" class=\"grid\"><div>Loading…</div></div></section>\n<section class=\"card\"><h2>📝 Drafts</h2><div id=\"drafts\">Loading…</div></section>\n<section class=\"card\"><h2>📢 Recent posts</h2><div id=\"recent\">Loading…</div></section>\n</main>\n<script>\nconst keyEl=document.getElementById(\"key\");keyEl.value=sessionStorage.getItem(\"adminKey\")||\"\";\nfunction saveKey(){sessionStorage.setItem(\"adminKey\",keyEl.value.trim());loadAll();}\nfunction headers(){return {\"Content-Type\":\"application/json\",\"x-admin-key\":sessionStorage.getItem(\"adminKey\")||\"\"};}\nasync function api(url,opt={}){const r=await fetch(url,{...opt,headers:{...headers(),...(opt.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||(\"HTTP \"+r.status));return d;}\nasync function loadAll(){const msg=document.getElementById(\"msg\");msg.textContent=\"Loading…\";try{\nconst [dash,drafts]=await Promise.all([fetch(\"/api/dashboard\").then(r=>r.json()),fetch(\"/api/content?status=draft&limit=20\").then(r=>r.json())]);\ndocument.getElementById(\"stats\").innerHTML=[[\"Content\",dash.totals?.total_content||0],[\"Published\",dash.totals?.published||0],[\"Drafts\",dash.totals?.drafts||0],[\"Affiliate clicks\",dash.affiliates?.affiliate_clicks||0]].map(x=>\"<div class='stat'><div class='muted'>\"+x[0]+\"</div><div class='num'>\"+x[1]+\"</div></div>\").join(\"\");\ndocument.getElementById(\"drafts\").innerHTML=(drafts.content||[]).map(renderItem).join(\"\")||\"<div class='muted'>No drafts.</div>\";\ndocument.getElementById(\"recent\").innerHTML=(dash.recent||[]).map(x=>\"<div class='item'><strong>#\"+x.id+\" \"+esc(x.title)+\"</strong><br><span class='badge'>\"+esc(x.category||\"\")+\"</span><span class='badge'>\"+esc(x.status||\"\")+\"</span><span class='badge'>Score \"+(x.ai_score??0)+\"</span></div>\").join(\"\");\nmsg.textContent=\"Updated\";msg.className=\"ok\";\n}catch(e){msg.textContent=e.message;msg.className=\"err\";}}\nfunction renderItem(x){return \"<div class='item'><strong>#\"+x.id+\" \"+esc(x.title)+\"</strong><br><span class='badge'>\"+esc(x.category||\"\")+\"</span><span class='badge'>Score \"+(x.ai_score??0)+\"</span><div class='post'>\"+esc(x.body||\"\")+\"</div><div>\"+(Number(x.ai_score)>=75&&x.body&&!x.body.startsWith(\"Collected from \")?\"<button onclick='publish(\"+x.id+\")'>Publish</button>\":\"\")+\"<button class='secondary' onclick='editPost(\"+x.id+\")'>Edit</button><button class='danger' onclick='rejectPost(\"+x.id+\")'>Reject</button></div></div>\";}\nfunction esc(s){return String(s).replace(/[&<>\"']/g,m=>({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"}[m]));}\nasync function publish(id){if(!confirm(\"Publish #\"+id+\" to Telegram?\"))return;try{await api(\"/api/content/\"+id+\"/publish\",{method:\"POST\"});loadAll();}catch(e){alert(e.message);}}\nasync function rejectPost(id){if(!confirm(\"Reject #\"+id+\"?\"))return;try{await api(\"/api/content/\"+id,{method:\"PATCH\",body:JSON.stringify({status:\"rejected\"})});loadAll();}catch(e){alert(e.message);}}\nasync function editPost(id){const body=prompt(\"Edit post text:\");if(body===null)return;try{await api(\"/api/content/\"+id,{method:\"PATCH\",body:JSON.stringify({body})});loadAll();}catch(e){alert(e.message);}}\nloadAll();\n</script></body></html>");
});

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
        source,        source_url,
        Number(ai_score) || 0
      ]    );

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
      q,
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

    if (q && String(q).trim()) {
      values.push("%" + String(q).trim() + "%");
      conditions.push(
        "(CAST(id AS TEXT) ILIKE $" + values.length + " OR title ILIKE $" + values.length + " OR body ILIKE $" + values.length + ")"
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

app.patch("/api/content/:id", requireAdmin, async (req, res) => {
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
  requireAdmin,
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



async function generateAffiliatePostWithAI(affiliate) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const product = affiliate.product || affiliate.company || "AI tool";
  const company = affiliate.company || product;
  const sourceUrl = affiliate.url || affiliate.affiliate_url || "";
  const keywords = affiliate.keywords || "";

  const sameProductAndCompany =
    product.trim().toLowerCase() === company.trim().toLowerCase();

  const identityRule = sameProductAndCompany
    ? "- Product and company have the same name. Mention the name naturally without phrasing like 'by' or 'from' the company."
    : "- Distinguish the product and company naturally; do not repeat the company name unnecessarily.";

  const prompt = `Create a factual Telegram partner recommendation for AI Opportunity Hub.

Product: ${product}
Company: ${company}
Official site: ${sourceUrl}
Known keywords/context: ${keywords}

Rules:
- Use only the information supplied above.
- Do not invent or infer features, pricing, plans, results, integrations, users, statistics, guarantees, benefits, or claims about what the product can do.
- Do not use implied benefits such as saving time, increasing productivity, improving results, simplifying work, or helping users unless that exact benefit is supplied above.
- Avoid phrases such as "aiming to", "could be useful", "potentially", "designed to", or "helps" when they add an unsupported interpretation.
- If the supplied information is limited, state only what is known and keep the post concise.
- Do not promise income, jobs, business results, or financial outcomes.
- Make it informative rather than sounding like an advertisement.
- Use 70-120 words when the supplied information supports that length; otherwise use fewer words.
- Avoid repetitive product/company wording.
${identityRule}
- A "Why check it out?" section is optional. Include it only if it can be written entirely from supplied facts; otherwise omit it.
- End with a short question inviting discussion that does not assume the reader has used the product.
- Do NOT include any affiliate link or disclosure; the server will add those.
- Return ONLY the finished Telegram post.
`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {    method: "POST",
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
          content: "Write concise, factual Telegram posts. Never invent facts. Return plain text only."
        },
        {
          role: "user",
          content: prompt
        }
      ],      temperature: 0.2,
      max_tokens: 350
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter HTTP ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim();

  if (!raw) {
    throw new Error("OpenRouter returned no affiliate post");
  }

  return cleanGeneratedPost(raw);
}

async function generateAffiliatePartnerDrafts(limit = 3) {
  const safeLimit = Math.min(Math.max(Number(limit) || 3, 1), 10);

  const { rows: affiliates } = await pool.query(
    `SELECT *
     FROM affiliate
     WHERE active = 1
       AND affiliate_url IS NOT NULL
       AND affiliate_url <> ''
     ORDER BY id ASC
     LIMIT $1`,
    [safeLimit]
  );

  const results = [];

  for (const affiliate of affiliates) {
    const title = `🤖 ${affiliate.product || affiliate.company}: AI Opportunity Hub Partner Pick`;

    const duplicate = await pool.query(
      `SELECT id, status
       FROM content
       WHERE LOWER(title) = LOWER($1)
       LIMIT 1`,
      [title]
    );

    if (duplicate.rows.length) {
      results.push({
        affiliate_id: affiliate.id,
        created: false,
        duplicate: true,
        content_id: duplicate.rows[0].id,
        status: duplicate.rows[0].status
      });
      continue;
    }

    try {
      const aiPost = await generateAffiliatePostWithAI(affiliate);

      const inserted = await pool.query(
        `INSERT INTO content
         (title, body, category, source, source_url, ai_score, status)
         VALUES ($1, $2, 'Digital Opportunities', $3, $4, 75, 'draft')
         RETURNING *`,
        [
          title,
          aiPost,
          affiliate.company || affiliate.product || "Partner",
          affiliate.url || affiliate.affiliate_url || ""
        ]
      );

      const row = inserted.rows[0];
      const trackedBody = `${aiPost.trim()}

🔗 Check it out: https://ai-opportunity-hub.onrender.com/go/affiliate/${affiliate.id}?content_id=${row.id}
ℹ️ ${affiliate.disclosure || "Affiliate link"}`;

      await pool.query(
        "UPDATE content SET body = $1 WHERE id = $2",
        [trackedBody, row.id]
      );

      results.push({
        affiliate_id: affiliate.id,
        created: true,
        content_id: row.id,
        status: "draft"
      });
    } catch (error) {
      results.push({
        affiliate_id: affiliate.id,
        created: false,
        error: error.message
      });
    }
  }

  return {
    processed: affiliates.length,
    results
  };
}

app.get("/api/affiliate/:id/content/preview", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM affiliate WHERE id = $1 AND active = 1 LIMIT 1",
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({
        preview: false,
        error: "Active affiliate not found"
      });
    }

    const affiliate = rows[0];
    const aiPost = await generateAffiliatePostWithAI(affiliate);

    res.json({
      preview: true,
      saved: false,
      published: false,
      affiliate: {
        id: affiliate.id,
        product: affiliate.product,
        company: affiliate.company,
        disclosure: affiliate.disclosure || "Affiliate link"
      },
      post: aiPost
    });
  } catch (error) {
    console.error("Affiliate preview error:", error);
    res.status(500).json({
      preview: false,
      error: error.message
    });
  }
});

app.get("/api/affiliate/:id/content", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM affiliate WHERE id = $1 AND active = 1 LIMIT 1",
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Active affiliate not found" });
    }

    const affiliate = rows[0];
    const title = `🤖 ${affiliate.product || affiliate.company}: AI Opportunity Hub Partner Pick`;

    const duplicate = await pool.query(
      `SELECT id, status FROM content
       WHERE LOWER(title) = LOWER($1)
       LIMIT 1`,
      [title]
    );

    if (duplicate.rows.length) {
      return res.json({
        created: false,
        duplicate: true,
        existing_content: duplicate.rows[0]
      });
    }

    const aiPost = await generateAffiliatePostWithAI(affiliate);
    const result = await pool.query(
      `INSERT INTO content
       (title, body, category, source, source_url, ai_score, status)
       VALUES ($1, $2, 'Digital Opportunities', $3, $4, 75, 'draft')
       RETURNING *`,
      [
        title,
        aiPost,
        affiliate.company || affiliate.product || "Partner",
        affiliate.url || affiliate.affiliate_url || ""
      ]
    );

    const trackedBody = `${aiPost.trim()}

🔗 Check it out: https://ai-opportunity-hub.onrender.com/go/affiliate/${affiliate.id}?content_id=${result.rows[0].id}
ℹ️ ${affiliate.disclosure || "Affiliate link"}`;

    const updated = await pool.query(
      "UPDATE content SET body = $1 WHERE id = $2 RETURNING *",
      [trackedBody, result.rows[0].id]
    );

    res.status(201).json({
      created: true,
      content: updated.rows[0],
      affiliate: {
        id: affiliate.id,
        product: affiliate.product,
        company: affiliate.company,
        disclosure: affiliate.disclosure || "Affiliate link"
      }
    });
  } catch (error) {
    res.status(500).json({ created: false, error: error.message });
  }
});

app.post("/api/affiliate/:id/content", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM affiliate WHERE id = $1 AND active = 1 LIMIT 1",
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Active affiliate not found" });
    }

    const affiliate = rows[0];
    const title =
      req.body?.title ||
      `🤖 ${affiliate.product || affiliate.company}: AI Opportunity Hub Partner Pick`;

    const aiPost = req.body?.body
      ? String(req.body.body).trim()
      : await generateAffiliatePostWithAI(affiliate);

    const duplicate = await pool.query(
      `SELECT id, status
       FROM content
       WHERE LOWER(title) = LOWER($1)
       LIMIT 1`,
      [title.trim()]
    );

    if (duplicate.rows.length) {
      return res.status(409).json({
        created: false,
        duplicate: true,
        existing_content: duplicate.rows[0]
      });
    }

    const result = await pool.query(
      `INSERT INTO content
       (title, body, category, source, source_url, ai_score, status)
       VALUES ($1, $2, 'Digital Opportunities', $3, $4, 75, 'draft')
       RETURNING *`,
      [
        title.trim(),
        aiPost,
        affiliate.company || affiliate.product || "Partner",
        affiliate.url || affiliate.affiliate_url || ""
      ]
    );

    const trackedBody = `${aiPost.trim()}

🔗 Check it out: https://ai-opportunity-hub.onrender.com/go/affiliate/${affiliate.id}?content_id=${result.rows[0].id}
ℹ️ ${affiliate.disclosure || "Affiliate link"}`;

    const updated = await pool.query(
      "UPDATE content SET body = $1 WHERE id = $2 RETURNING *",
      [trackedBody, result.rows[0].id]
    );

    res.status(201).json({
      created: true,
      content: updated.rows[0],
      affiliate: {
        id: affiliate.id,
        product: affiliate.product,
        company: affiliate.company,
        disclosure: affiliate.disclosure || "Affiliate link"
      }
    });
  } catch (error) {
    res.status(500).json({
      created: false,
      error: error.message
    });
  }
});

app.get("/api/affiliate/content/:id/publish", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM content WHERE id = $1 LIMIT 1",
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ published: false, error: "Content not found" });
    }

    const content = rows[0];

    if (content.category !== "Digital Opportunities") {
      return res.status(400).json({
        published: false,
        error: "This approval route is only for Digital Opportunities posts"
      });
    }

    if (content.status !== "draft") {
      return res.status(400).json({
        published: false,
        error: `Content is already ${content.status}`
      });
    }

    if (Number(content.ai_score || 0) < 75) {
      return res.status(400).json({
        published: false,
        error: "Content score must be 75 or higher"
      });
    }

    if (!content.body || String(content.body).trim() === "") {
      return res.status(400).json({
        published: false,
        error: "Content body is empty"
      });
    }

    const telegramResult = await telegram("sendMessage", {
      chat_id: CHANNEL_USERNAME,
      text: content.body,
      disable_web_page_preview: false
    });

    if (!telegramResult?.ok || !telegramResult?.result?.message_id) {
      throw new Error(telegramResult?.description || "Telegram publish failed");
    }

    const telegramMessageId = telegramResult.result.message_id;

    await pool.query(
      `UPDATE content
       SET status = 'published',           telegram_message_id = $1,
           published_at = CURRENT_TIMESTAMP       WHERE id = $2`,
      [telegramMessageId, content.id]
    );

    res.json({
      published: true,
      content: {
        id: content.id,
        title: content.title,
        status: "published",
        telegram_message_id: telegramMessageId
      }
    });
  } catch (error) {
    res.status(500).json({
      published: false,
      error: error.message
    });
  }
});

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

app.get("/api/affiliate/dashboard", async (req, res) => {
  try {
    const summary = await pool.query(
      `SELECT
         COUNT(*)::int AS total_affiliates,
         COUNT(*) FILTER (WHERE active = 1)::int AS active_affiliates,
         COALESCE((SELECT COUNT(*) FROM affiliate_clicks), 0)::int AS total_clicks
       FROM affiliate`
    );

    const affiliates = await pool.query(
      `SELECT
         a.id,
         a.product,
         a.company,
         a.commission,
         a.active,
         COUNT(ac.id)::int AS clicks
       FROM affiliate a
       LEFT JOIN affiliate_clicks ac ON ac.affiliate_id = a.id
       GROUP BY a.id
       ORDER BY clicks DESC, a.id ASC`
    );

    const posts = await pool.query(
      `SELECT
         c.id,
         c.title,
         c.status,
         c.published_at,
         COUNT(ac.id)::int AS affiliate_clicks
       FROM content c
       LEFT JOIN affiliate_clicks ac
         ON ac.content_id = c.id
       WHERE c.category = 'Digital Opportunities'
       GROUP BY c.id
       ORDER BY c.id DESC
       LIMIT 20`
    );

    res.json({
      dashboard: true,
      summary: summary.rows[0],
      affiliates: affiliates.rows,
      partner_posts: posts.rows
    });
  } catch (error) {
    res.status(500).json({
      dashboard: false,
      error: error.message
    });
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

app.post("/api/affiliate", requireAdmin, async (req, res) => {
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

app.patch("/api/affiliate/:id", requireAdmin, async (req, res) => {
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

app.delete("/api/affiliate/:id", requireAdmin, async (req, res) => {
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

  const source = String(content.source || "");
  const title = String(content.title || "");
  const lowerTitle = title.toLowerCase();
  const isWellfound = source.toLowerCase().includes("wellfound");
  const aiJobPatterns = [
    /\bai\b/i,
    /artificial intelligence/i,
    /machine learning/i,
    /\bml\b/i,
    /deep learning/i,
    /\bllm\b/i,
    /generative ai/i,
    /\bgenai\b/i,
    /computer vision/i,
    /\bnlp\b/i,
    /natural language/i,
    /robotics/i,
    /autonomous/i,
    /data science/i,
    /data scientist/i,
    /mlops/i,
    /machine intelligence/i,
    /applied ai/i,
    /ai platform/i,
    /ai engineer/i,
    /ai researcher/i,
    /ai research/i,
    /ai product/i,
    /ai consultant/i,
    /ai consulting/i,
    /ai solutions/i,
    /ai architect/i,
    /prompt engineer/i,
    /agentic ai/i
  ];

  const wellfoundAiJob = aiJobPatterns.some((pattern) =>
    pattern.test(title)
  );

  let verifiedContext = String(content.body || "");
  if (
    isWellfound &&
    content.source_url &&
    (!verifiedContext || verifiedContext.startsWith("Collected from "))
  ) {
    try {
      const jobHtml = await fetchPage(content.source_url);
      const jobPage = cheerio.load(jobHtml);
      const metaDescription =
        jobPage('meta[name="description"]').attr("content") ||
        jobPage('meta[property="og:description"]').attr("content") ||
        "";
      const visibleText = jobPage("body").text().replace(/\s+/g, " ").trim();
      verifiedContext = [metaDescription, visibleText.slice(0, 5000)]
        .filter(Boolean)
        .join("\n");
    } catch {
      verifiedContext = "";
    }
  }

  const sourceRules = isWellfound
    ? `
WELLFOUND JOB RULES:
- This source is a job source. The category MUST be "AI Jobs" when the listing is genuinely AI/ML-related.
- A Wellfound listing is AI-related only when the title clearly contains an AI/ML signal such as AI, artificial intelligence, machine learning, ML, LLM, generative AI, NLP, computer vision, robotics, data science, or a clearly AI-specific engineering/research role.
- Do NOT classify generic engineering, support, sales, account management, procurement, finance, operations, recycling, HR, marketing, or other non-AI roles as AI Jobs merely because the company may work in technology.
- If the title clearly names an AI/ML role, treat that as strong evidence that the listing is AI-related. Do not reject it merely because the page description is limited.
- Use the verified source context when available to assess usefulness, freshness, engagement, and monetization.
- If the listing is not clearly AI-related, give it a score of 0-20, set category to "AI Jobs", and set publishable to false.
- Never give an unrelated Wellfound job a score of 75 or higher.
`
    : `
GENERAL SOURCE RULES:
- Choose the category from the actual content and source context.
- Do not label a job listing as AI News.
- Do not label a job as an AI Tool, tutorial, or news item unless the source content clearly supports that category.
`;

  const prompt = `You are the quality editor for AI Opportunity Hub, a Telegram channel about useful AI tools, jobs, digital opportunities, Android/AI apps, tutorials, AI news, and free resources.

Evaluate this candidate:
Title: ${title}
Source: ${source}
URL: ${content.source_url || ""}
Verified source context:
${verifiedContext || "(No additional source text was available.)"}

${sourceRules}

Return ONLY valid JSON:
{"score":0,"category":"AI News","reason":"short factual reason","publishable":false}

Scoring dimensions:
- Usefulness: 25
- Relevance to AI Opportunity Hub: 20
- Freshness: 20
- Engagement potential: 15
- Monetization potential: 10
- Source quality: 10

Important:
- Relevance is mandatory. A candidate that is not genuinely relevant to the channel must score low even if the source is reputable.
- Do not reward a reputable source for unrelated content.
- Set publishable=true only when score >= 75.
- Do not invent facts.
`;

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
    .replace(/^\\`\\`\\`json\\s*/i, "")
    .replace(/\\s*\\`\\`\\`$/i, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const repaired = cleaned
      .replace(/"score"\\s*:\\s*seventy\\b/gi, '"score": 70')
      .replace(/"score"\\s*:\\s*eighty\\b/gi, '"score": 80')
      .replace(/"score"\\s*:\\s*sixty\\b/gi, '"score": 60')
      .replace(/"score"\\s*:\\s*fifty\\b/gi, '"score": 50')
      .replace(/"score"\\s*:\\s*ninety\\b/gi, '"score": 90')
      .replace(/"score"\\s*:\\s*one hundred\\b/gi, '"score": 100');
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

  let category = allowedCategories.includes(parsed.category)
    ? parsed.category
    : "AI News";

  if (isWellfound) {
    category = "AI Jobs";
    if (!wellfoundAiJob) {
      score = Math.min(score, 20);
    }
  }

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

  let verifiedContext = "";
  if (category === "AI Jobs" && content.source && /Wellfound/i.test(content.source) && content.source_url) {
    try {
      const jobHtml = await fetchPage(content.source_url);
      const jobPage = cheerio.load(jobHtml);
      const metaDescription =
        jobPage('meta[name="description"]').attr("content") ||
        jobPage('meta[property="og:description"]').attr("content") ||
        "";
      const visibleText = jobPage("body").text().replace(/\\s+/g, " ").trim();
      verifiedContext = [metaDescription, visibleText.slice(0, 5000)]
        .filter(Boolean)
        .join("\\n");
    } catch {
      verifiedContext = "";
    }
  }

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
Verified source context (use only if present; do not infer missing facts):
${verifiedContext || "(No additional source text was available.)"}

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
     WHERE active = 1       AND affiliate_url IS NOT NULL       AND affiliate_url <> ''
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

app.get("/api/ai/generate-drafts", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 25);

    const { rows } = await pool.query(
      `SELECT * FROM content
       WHERE status = 'draft'
         AND ai_score >= 75
         AND category <> 'Digital Opportunities'
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
        COUNT(*)::int AS total_content,        COUNT(*) FILTER (WHERE status = 'published')::int AS published,
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


// ==================== PREMIUM / TELEGRAM STARS ====================
async function sendPremiumInvoice(chatId, product) {
  return telegram("sendInvoice", {
    chat_id: chatId,
    title: product.title.slice(0, 32),
    description: product.description.slice(0, 255),
    payload: `premium:${product.id}`,
    provider_token: "",
    currency: "XTR",
    prices: [{ label: product.title.slice(0, 32), amount: Number(product.price_stars) }]
  });
}

function escapeTelegramHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendTelegramCategory(chatId, command) {
  const categories = {
    tools: "AI Tools",
    jobs: "AI Jobs",
    free: "Free Resources",
    learn: "AI Tutorials"
  };
  const labels = {
    tools: "🤖 AI Tools",
    jobs: "💼 AI Jobs",
    free: "🎁 Free AI Resources",
    learn: "🧠 Learn AI"
  };

  const category = categories[command];
  if (!category) return;

  let { rows } = await pool.query(
    `SELECT title, body, source_url
     FROM content
     WHERE status = 'published' AND category = $1
     ORDER BY published_at DESC NULLS LAST, id DESC
     LIMIT 8`,
    [category]
  );

  // If the exact category has no published items, give the member useful
  // recent content instead of returning an empty-looking result.
  if (!rows.length) {
    const fallback = await pool.query(
      `SELECT title, body, source_url, category
       FROM content
       WHERE status = 'published'
       ORDER BY published_at DESC NULLS LAST, id DESC
       LIMIT 5`
    );
    rows = fallback.rows;
  }

  const lines = [
    `<b>${escapeTelegramHtml(labels[command])}</b>`,
    rows.length
      ? "Here are the latest available items:"
      : "There are no published items yet. New items will appear here automatically."
  ];

  for (const item of rows) {
    const body = String(item.body || "").trim().slice(0, 700);
    lines.push(
      `\n<b>• ${escapeTelegramHtml(item.title)}</b>` +
      (item.category ? `\n🏷️ ${escapeTelegramHtml(item.category)}` : "") +
      (body ? `\n${escapeTelegramHtml(body)}` : "") +
      (item.source_url ? `\n🔗 <a href="${escapeTelegramHtml(item.source_url)}">Source / Apply</a>` : "")
    );
  }

  lines.push(
    "\nUse the buttons below to switch services.",
  );

  await telegram("sendMessage", {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: false,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🤖 AI Tools", callback_data: "menu:tools" },
          { text: "💼 AI Jobs", callback_data: "menu:jobs" }
        ],
        [
          { text: "🎁 Free Resources", callback_data: "menu:free" },
          { text: "🧠 Learn AI", callback_data: "menu:learn" }
        ],
        [
          { text: "⭐ Premium", callback_data: "menu:premium" }
        ]
      ]
    }
  });
}

async function sendTelegramPremium(chatId) {
  const { rows } = await pool.query(
    "SELECT id, title, description, price_stars FROM premium_products WHERE active = 1 ORDER BY id ASC"
  );

  if (!rows.length) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "⭐ Premium is being prepared. Please check back soon.",
      reply_markup: {
        inline_keyboard: [
          [{ text: "⬅️ Main Menu", callback_data: "menu:home" }]
        ]
      }
    });
    return;
  }

  const lines = ["⭐ <b>AI Opportunity Hub Premium</b>", "Premium digital resources:"];
  const keyboard = [];

  for (const product of rows) {
    lines.push(
      `\n<b>#${product.id} ${escapeTelegramHtml(product.title)}</b> — ${Number(product.price_stars)} Stars\n${escapeTelegramHtml(product.description)}`
    );
    keyboard.push([
      { text: `⭐ Buy #${product.id} — ${Number(product.price_stars)} Stars`, callback_data: `buy:${product.id}` }
    ]);
  }

  keyboard.push([{ text: "⬅️ Main Menu", callback_data: "menu:home" }]);

  await telegram("sendMessage", {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendTelegramHome(chatId) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      "🤖 <b>AI Opportunity Hub</b>\n\n" +
      "Your Telegram assistant for useful AI tools, AI jobs, free resources, tutorials and premium guides.\n\n" +
      "Choose a service:",
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🤖 AI Tools", callback_data: "menu:tools" },
          { text: "💼 AI Jobs", callback_data: "menu:jobs" }
        ],
        [
          { text: "🎁 Free Resources", callback_data: "menu:free" },
          { text: "🧠 Learn AI", callback_data: "menu:learn" }
        ],
        [
          { text: "⭐ Premium", callback_data: "menu:premium" }
        ]
      ]
    }
  });
}

async function handleTelegramUpdate(update) {
  try {
    if (!update) return;

    if (update.pre_checkout_query) {
      await telegram("answerPreCheckoutQuery", {
        pre_checkout_query_id: update.pre_checkout_query.id,
        ok: true
      });
      return;
    }

    if (update.callback_query) {
      const query = update.callback_query;
      const data = String(query.data || "");
      const chatId = query.message?.chat?.id || query.from?.id;

      // Telegram keeps a callback button in a loading state until the bot
      // answers the callback query.
      await telegram("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Loading..."
      });

      if (data === "menu:home") {
        await sendTelegramHome(chatId);
        return;
      }

      if (data.startsWith("buy:")) {
        const productId = Number(data.split(":")[1]);
        const { rows } = await pool.query(
          "SELECT * FROM premium_products WHERE id = $1 AND active = 1 LIMIT 1",
          [productId]
        );
        if (!rows.length) {
          await telegram("sendMessage", {
            chat_id: chatId,
            text: "That premium product is no longer available."
          });
          return;
        }
        await sendPremiumInvoice(chatId, rows[0]);
        return;
      }

      if (data.startsWith("menu:")) {
        const command = data.split(":")[1];
        if (command === "premium") {
          await sendTelegramPremium(chatId);
          return;
        }
        await sendTelegramCategory(chatId, command);
        return;
      }

      return;
    }

    const message = update.message;
    if (!message?.chat?.id) return;

    if (message.successful_payment) {
      const payload = String(message.successful_payment.invoice_payload || "");
      if (!payload.startsWith("premium:")) return;

      const productId = Number(payload.split(":")[1]);
      const { rows } = await pool.query(
        "SELECT * FROM premium_products WHERE id = $1 AND active = 1 LIMIT 1",
        [productId]
      );
      if (!rows.length) return;

      await telegram("sendMessage", {
        chat_id: message.chat.id,
        text:
          `💳 <b>Payment received</b>\n\n<b>${escapeTelegramHtml(rows[0].title)}</b>\n\n${escapeTelegramHtml(rows[0].content)}`,
        parse_mode: "HTML"
      });
      return;
    }

    const textMessage = String(message.text || "").trim().split(" ")[0].toLowerCase();

    if (textMessage === "/start" || textMessage === "/help") {
      await sendTelegramHome(message.chat.id);
      return;
    }

    const commandMap = {
      "/tools": "tools",
      "/jobs": "jobs",
      "/free": "free",
      "/learn": "learn"
    };

    if (commandMap[textMessage]) {
      await sendTelegramCategory(message.chat.id, commandMap[textMessage]);
      return;
    }

    if (textMessage === "/premium") {
      await sendTelegramPremium(message.chat.id);
      return;
    }

    // Give every unknown message a useful response instead of silently ignoring it.
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text:
        "I can help you access AI services.\n\n" +
        "Use /start or choose a service below:",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🤖 AI Tools", callback_data: "menu:tools" },
            { text: "💼 AI Jobs", callback_data: "menu:jobs" }
          ],
          [
            { text: "🎁 Free Resources", callback_data: "menu:free" },
            { text: "🧠 Learn AI", callback_data: "menu:learn" }
          ],
          [
            { text: "⭐ Premium", callback_data: "menu:premium" }
          ]
        ]
      }
    });
  } catch (error) {
    console.error("Telegram update error:", error.message);
  }
}

app.get("/telegram/diagnostics", async (req, res) => {
  try {
    const webhook = await telegram("getWebhookInfo");
    const me = await telegram("getMe");
    res.json({
      ok: true,
      bot: me.result?.username,
      webhook: {
        url: webhook.result?.url || "",
        pending_update_count: webhook.result?.pending_update_count || 0,
        last_error_date: webhook.result?.last_error_date || null,
        last_error_message: webhook.result?.last_error_message || null
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

async function telegramWebhookHandler(req, res) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.get("x-telegram-bot-api-secret-token") !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Acknowledge Telegram immediately, then process the update.
  res.sendStatus(200);
  try {
    await handleTelegramUpdate(req.body);
  } catch (error) {
    console.error("Telegram webhook processing error:", error.message);
  }
}

// Accept both URL forms so a trailing-slash normalization by a proxy cannot produce 404.
app.post("/telegram/webhook", telegramWebhookHandler);
app.post("/telegram/webhook/", telegramWebhookHandler);

// Health response for browser/proxy checks; Telegram still uses POST.
app.get("/telegram/webhook", (req, res) => {
  res.json({ ok: true, endpoint: "telegram-webhook" });
});
app.get("/telegram/webhook/", (req, res) => {
  res.json({ ok: true, endpoint: "telegram-webhook" });
});

app.get("/api/premium", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, title, description, price_stars, active, created_at FROM premium_products ORDER BY id ASC");
    res.json({ premium: true, products: rows });
  } catch (error) {
    res.status(500).json({ premium: false, error: error.message });
  }
});

app.get("/api/analytics/summary", async (req, res) => {
  try {
    const totals = await pool.query(`
      SELECT COUNT(*)::int AS total_content,
             COUNT(*) FILTER (WHERE status = 'published')::int AS published,
             COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts,
             COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
             COALESCE(SUM(views),0)::int AS views,
             COALESCE(SUM(clicks),0)::int AS clicks,
             COALESCE(AVG(performance_score),0)::numeric(10,2) AS avg_performance
      FROM analytics
    `);
    const categories = await pool.query(`SELECT category, COUNT(*)::int AS published FROM content WHERE status='published' GROUP BY category ORDER BY published DESC`);
    res.json({ analytics: true, totals: totals.rows[0], categories: categories.rows });
  } catch (error) {
    res.status(500).json({ analytics: false, error: error.message });
  }
});

app.get("/api/system/status", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    const content = await pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='published')::int AS published, COUNT(*) FILTER (WHERE status='draft')::int AS drafts FROM content");
    const affiliates = await pool.query("SELECT COUNT(*)::int AS count FROM affiliate WHERE active=1");
    const premium = await pool.query("SELECT COUNT(*)::int AS count FROM premium_products WHERE active=1");
    res.json({status:"ok",service:"AI Opportunity Hub",database:"connected",telegram:BOT_TOKEN?"configured":"missing",automation:"30-minute cycle",auto_publish_threshold:75,max_posts_per_cycle:3,content:content.rows[0],active_affiliates:Number(affiliates.rows[0].count),premium_products:Number(premium.rows[0].count)});
  } catch (error) { res.status(500).json({status:"error",error:error.message}); }
});

async function runAutomationCycle() {
  console.log("Starting automation cycle...");

  try {
    const collectResponse = await fetch(
      `http://127.0.0.1:${PORT}/api/collect`
    );
    const collectResult = await collectResponse.json();
    console.log("Collector:", collectResult.total_saved ?? collectResult.error);

    const affiliateAutomation = await generateAffiliatePartnerDrafts(3);
    console.log("Affiliate automation:", affiliateAutomation);

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

        const nextStatus =
          evaluation.score <= 20
            ? "rejected"
            : "draft";

        await pool.query(
          `UPDATE content
           SET ai_score = $1,
               category = $2,
               status = $4
           WHERE id = $3`,
          [evaluation.score, evaluation.category, content.id, nextStatus]
        );

        scored++;
        console.log(
          `Scored #${content.id}: ${evaluation.score} (${nextStatus})`
        );
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
        await pool.query(
          `INSERT INTO analytics (content_id, views, reactions, comments, clicks, ctr, performance_score)
           VALUES ($1, 0, 0, 0, 0, 0, 0)`,
          [content.id]
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
      affiliate_automation: affiliateAutomation,
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
      if (BOT_TOKEN) {
        telegram("setMyCommands", {
          commands: [
            { command: "start", description: "Start AI Opportunity Hub" },
            { command: "tools", description: "Find useful AI tools" },
            { command: "jobs", description: "AI jobs and opportunities" },
            { command: "free", description: "Free AI resources" },
            { command: "learn", description: "AI tutorials" },
            { command: "premium", description: "Premium resources" },
            { command: "help", description: "Get help" }
          ]
        }).catch((error) => console.error("Telegram commands setup failed:", error.message));
      }

      if (process.env.PUBLIC_BASE_URL && BOT_TOKEN) {
        const webhookUrl = `${process.env.PUBLIC_BASE_URL.endsWith("/") ? process.env.PUBLIC_BASE_URL.slice(0, -1) : process.env.PUBLIC_BASE_URL}/telegram/webhook`;
        telegram("setWebhook", {
          url: webhookUrl,
          ...(process.env.TELEGRAM_WEBHOOK_SECRET ? { secret_token: process.env.TELEGRAM_WEBHOOK_SECRET } : {})
        }).then(() => console.log("Telegram webhook configured:", webhookUrl))
          .catch((error) => console.error("Telegram webhook setup failed:", error.message));
      }

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