import express from "express";

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TEST_CHAT_ID = process.env.TELEGRAM_TEST_CHAT_ID;
const CHANNEL_USERNAME = process.env.TELEGRAM_CHANNEL_USERNAME;

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

  return response.json();
}

app.get("/", (req, res) => {
  res.json({
    service: "AI Opportunity Hub",
    status: "online"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok"
  });
});

app.get("/telegram-test", async (req, res) => {
  try {
    const result = await telegram("getMe");

    if (!result.ok) {
      return res.status(500).json({
        connected: false,
        telegram: result
      });
    }

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
        sent: false,
        error: "TELEGRAM_TEST_CHAT_ID is not configured"
      });
    }

    const result = await telegram("sendMessage", {
      chat_id: TEST_CHAT_ID,
      text:
        "🤖 AI Opportunity Hub is connected!\n\n" +
        "Telegram → Render → Bot API is working."
    });

    if (!result.ok) {
      return res.status(500).json({
        sent: false,
        telegram: result
      });
    }

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

app.get("/publish-test", async (req, res) => {
  try {
    if (!CHANNEL_USERNAME) {
      return res.status(500).json({
        published: false,
        error: "TELEGRAM_CHANNEL_USERNAME is not configured"
      });
    }

    const result = await telegram("sendMessage", {
      chat_id: CHANNEL_USERNAME,
      text:
        "🚀 AI Opportunity Hub\n\n" +
        "This is our first automated channel post.\n\n" +
        "The Telegram publishing system is working. More AI tools, jobs, resources and opportunities are coming soon.\n\n" +
        "What would you like to see most?\n\n" +
        "🤖 AI Tools\n" +
        "💼 AI Jobs\n" +
        "📱 AI Apps\n" +
        "💰 Digital Opportunities"
    });

    if (!result.ok) {
      return res.status(500).json({
        published: false,
        telegram: result
      });
    }

    res.json({
      published: true,
      message_id: result.result.message_id,
      channel: CHANNEL_USERNAME
    });
  } catch (error) {
    res.status(500).json({
      published: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`AI Opportunity Hub running on port ${PORT}`);
});
