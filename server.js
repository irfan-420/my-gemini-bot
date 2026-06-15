const express = require("express");
const app = express();

app.use(express.json());

// হোম রুট
app.get("/", (req, res) => {
  res.send("বট সার্ভার সচল আছে এবং স্মার্ট ফলব্যাক সিস্টেম চালু আছে!");
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

// এপিআই কল করার হেল্পার ফাংশন (টাইমআউট সহ)
async function callGemini(modelId, prompt) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // ১০ সেকেন্ডের লিমিট

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null; // এরর হলে (যেমন 503) null রিটার্ন করবে

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (error) {
    clearTimeout(timeoutId);
    return null; // টাইমআউট বা নেটওয়ার্ক এরর হলে null রিটার্ন করবে
  }
}

// মূল ফাংশন যেখানে ৩.৫ এবং ৩.১ এর চেইন লজিক আছে
async function getGeminiResponse(prompt) {
  console.log("Trying: Gemini 3.5 Flash...");
  
  // ১. প্রথমে ৩.৫ এর কাছে চেষ্টা
  let reply = await callGemini("gemini-3.5-flash", prompt);
  if (reply) return reply;

  // ২. ৩.৫ ব্যর্থ হলে ৩.১ লাইটের কাছে চেষ্টা
  console.log("3.5 failed or busy, switching to Gemini 3.1 Flash Lite...");
  reply = await callGemini("gemini-3.1-flash-lite", prompt);
  if (reply) return reply;

  // ৩. দুটি মডেলই ব্যর্থ হলে ফাইনাল মেসেজ
  return "দুঃখিত, বর্তমানে সার্ভারে অতিরিক্ত চাপ থাকার কারণে আমি এই উত্তর দিতে পারছি না। দয়া করে কিছুক্ষণ পর আবার চেষ্টা করুন।";
}

// ফেসবুক মেসেজ রিসিভ এবং রিপ্লাই
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object === "page") {
    for (const entry of body.entry) {
      if (entry.messaging) {
        const webhook_event = entry.messaging[0];
        if (webhook_event?.message?.text) {
          const sender_psid = webhook_event.sender.id;
          const user_message = webhook_event.message.text;
          
          const ai_reply = await getGeminiResponse(user_message);
          
          const fbUrl = `https://graph.facebook.com/v21.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`;
          await fetch(fbUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              recipient: { id: sender_psid },
              message: { text: ai_reply }
            })
          });
        }
      }
    }
    res.status(200).send("EVENT_RECEIVED");
  } else {
    res.sendStatus(404);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
