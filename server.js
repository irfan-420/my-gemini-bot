const express = require("express");
const app = express();

app.use(express.json());

// হোম রুট
app.get("/", (req, res) => {
  res.send("বট সার্ভার সচল আছে!");
});

// ফেসবুক মেসেঞ্জার ভেরিফিকেশন
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// মেসেজ রিসিভ এবং রিপ্লাই
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object === "page") {
    for (const entry of body.entry) {
      if (entry.messaging) {
        const webhook_event = entry.messaging[0];
        if (webhook_event?.message?.text) {
          const sender_psid = webhook_event.sender.id;
          const user_message = webhook_event.message.text;
          
          console.log(`User Said: ${user_message}`);
          const ai_reply = await getGeminiResponse(user_message);
          await sendFacebookMessage(sender_psid, ai_reply);
        }
      }
    }
    res.status(200).send("EVENT_RECEIVED");
  } else {
    res.sendStatus(404);
  }
});

// জেমিনি এপিআই ফাংশন
async function getGeminiResponse(prompt) {
  try {
    const modelId = "gemini-1.5-flash"; 
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });
    
    const data = await response.json();
    
    if (data.candidates && data.candidates[0].content.parts[0].text) {
      return data.candidates[0].content.parts[0].text;
    } else {
      console.log("Full Gemini Response:", JSON.stringify(data));
      return "দুঃখিত, জেমিনি এখন রেসপন্স দিচ্ছে না।";
    }
  } catch (error) {
    console.error("Error:", error);
    return "সার্ভার এরর!";
  }
}

// ফেসবুক মেসেজ ফাংশন
async function sendFacebookMessage(sender_psid, text_reply) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: sender_psid },
      message: { text: text_reply }
    })
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
