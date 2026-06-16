const express = require("express");
const app = express();

app.use(express.json());

// ছবি মনে রাখার জন্য মেমোরি (সার্ভার রিস্টার্ট দিলে এটি ক্লিয়ার হয়ে যাবে)
let pendingImages = {}; 

app.get("/", (req, res) => {
  res.send("বট সার্ভার সচল আছে! (3.5 + 3.1 Flash Lite + Google Live Search Enabled)");
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

// এপিআই কল করার হেল্পার ফাংশন (টাইমআউট, ফলব্যাক এবং গুগল সার্চসহ)
async function callGemini(modelId, prompt, imageUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // সার্চ করতে সময় লাগতে পারে তাই ১৫ সেকেন্ড টাইমআউট

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    let parts = [];
    if (imageUrl) {
      parts.push({ fileData: { mimeType: "image/jpeg", fileUri: imageUrl } });
    }
    parts.push({ text: prompt });

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        contents: [{ parts: parts }],
        // এই লাইনটি বটকে গুগলে সার্চ করে একদম লেটেস্ট খবর বের করার ক্ষমতা দেবে
        tools: [{ googleSearch: {} }] 
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    if (!response.ok) return null; // এরর হলে (503 বা অন্য) null রিটার্ন করবে

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (error) {
    clearTimeout(timeoutId);
    return null; 
  }
}

// মূল ফাংশন যেখানে ৩.৫ এবং ৩.১ এর চেইন লজিক আছে
async function getGeminiResponse(prompt, imageUrl) {
  // ১. প্রথমে ৩.৫ এর কাছে চেষ্টা
  let reply = await callGemini("gemini-3.5-flash", prompt, imageUrl);
  if (reply) return reply;

  // ২. ৩.৫ ব্যর্থ হলে ৩.১ লাইটের কাছে চেষ্টা
  reply = await callGemini("gemini-3.1-flash-lite", prompt, imageUrl);
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
        const event = entry.messaging[0];
        const senderId = event.sender.id;

        // ছবি সনাক্তকরণ
        if (event.message?.attachments) {
          const attachment = event.message.attachments[0];
          if (attachment.type === "image") {
            pendingImages[senderId] = attachment.payload.url;
            return res.status(200).send("EVENT_RECEIVED"); // ছবি পেলে বট চুপ থাকবে
          }
        }

        // টেক্সট প্রশ্ন সনাক্তকরণ
        if (event.message?.text) {
          const userMessage = event.message.text;
          const savedImage = pendingImages[senderId] || null;
          
          // জেমিনি থেকে রেসপন্স নেওয়া (সার্চ রেজাল্টসহ)
          const aiReply = await getGeminiResponse(userMessage, savedImage);
          
          // উত্তর দেওয়ার পর ইমেজ মেমোরি ক্লিয়ার
          pendingImages[senderId] = null;

          const fbUrl = `https://graph.facebook.com/v21.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`;
          await fetch(fbUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              recipient: { id: senderId },
              message: { text: aiReply }
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
