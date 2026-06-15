const express = require("express");
const app = express();

app.use(express.json());

// হোম রুট
app.get("/", (req, res) => {
  res.send("বট সার্ভার সচল আছে এবং Gemini 2.5 Flash ব্যবহার করছে!");
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

// জেমিনি এপিআই ফাংশন (Gemini 2.5 Flash ব্যবহার করে)
async function getGeminiResponse(prompt) {
  try {
    // মডেল আইডি: gemini-2.5-flash
    const modelId = "gemini-2.5-flash"; 
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    // 503 এরর হ্যান্ডলিং
    if (response.status === 503) {
      return "সার্ভারে এই মুহূর্তে খুব চাপ রয়েছে। দয়া করে কিছুক্ষণ পর আবার মেসেজ দিন।";
    }
    
    const data = await response.json();
    
    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text;
    } else {
      console.error("Gemini API Error:", JSON.stringify(data));
      return "দুঃখিত, এই মডেলটি এখন রেসপন্স দিতে পারছে না।";
    }
  } catch (error) {
    console.error("Fetch Error:", error);
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
