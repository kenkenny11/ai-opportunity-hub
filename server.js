import express from "express";

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TEST_CHAT_ID = process.env.TELEGRAM_TEST_CHAT_ID;

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

// Main status endpoint
app.get("/", (req, res) => {
  res.json({
    service: "AI Opportunity Hub",
    status: "online"
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok"
  });
});

// Check Telegram connection
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

// Send private test message
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

app.listen(PORT, () => {
  console.log(`AI Opportunity Hub running on port ${PORT}`);
});
