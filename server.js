const express = require("express");
const app = express();

app.use(express.json());

// ছবি মনে রাখার জন্য সাময়িক মেমোরি
let pendingImages = {}; 

app.get("/", (req, res) => {
  res.send("বট সার্ভার সচল আছে! (100% Free Native Live Search with Quota Detector)");
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

// এপিআই কল করার হেল্পার ফাংশন
async function callGemini(modelId, prompt, imageUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000); // ২০ সেকেন্ড টাইমআউট

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    let parts = [];
    
    // ছবি প্রসেস লজিক
    if (imageUrl) {
      try {
        const imgResponse = await fetch(imageUrl);
        if (imgResponse.ok) {
          const arrayBuffer = await imgResponse.arrayBuffer();
          const base64Data = Buffer.from(arrayBuffer).toString("base64");
          const contentType = imgResponse.headers.get("content-type") || "image/jpeg";
          parts.push({ inlineData: { mimeType: contentType, data: base64Data } });
        }
      } catch (err) {
        console.error("Image error:", err.message);
      }
    }
    
    parts.push({ text: prompt });

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        contents: [{ parts: parts }],
        // গুগলের ডাইরেক্ট লাইভ সার্চ টুল (কোনো থার্ড পার্টি কাহিনী ছাড়া)
        tools: [{ googleSearchRetrieval: {} }] 
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // যদি ৪২৯ (কোটা শেষ) এরর আসে, তবে বিশেষ কোড রিটার্ন করবে
    if (response.status === 429) {
      return "LIMIT_EXHAUSTED";
    }

    if (!response.ok) return null; 

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (error) {
    clearTimeout(timeoutId);
    return null; 
  }
}

// মূল রেসপন্স হ্যান্ডলার (১ মিনিটের লিমিট ডিটেক্টরসহ)
async function getGeminiResponse(prompt, imageUrl) {
  console.log(`[Process] Requesting gemini...`);
  
  // ১. প্রথম মডেল কল
  let reply = await callGemini("gemini-3.5-flash", prompt, imageUrl);
  
  // যদি গুগলের ফ্রি লিমিট শেষ হয়ে যায়
  if (reply === "LIMIT_EXHAUSTED") {
    return "ভাই, গুগলের ফ্রি লাইভ সার্চের ১ মিনিটের লিমিট শেষ হয়ে গেছে। দয়া করে ঠিক ১ মিনিট পর আবার এই প্রশ্নটি করুন, আমি সার্চ করে উত্তর দিয়ে দেবো।";
  }
  if (reply) return reply;

  // ২. প্রথম মডেল ফেইল হলে দ্বিতীয় মডেল কল
  reply = await callGemini("gemini-3.1-flash-lite", prompt, imageUrl);
  if (reply === "LIMIT_EXHAUSTED") {
    return "ভাই, গুগলের ফ্রি লাইভ সার্চের ১ মিনিটের লিমিট শেষ হয়ে গেছে। দয়া করে ঠিক ১ মিনিট পর আবার এই প্রশ্নটি করুন, আমি সার্চ করে উত্তর দিয়ে দেবো।";
  }
  if (reply) return reply;

  return "দুঃখিত ভাই, এই মুহূর্তে সার্ভারে অতিরিক্ত চাপ রয়েছে। দয়া করে একটু পর আবার চেষ্টা করুন।";
}

// ফেসবুক মেসেজ রিসিভ এবং রিপ্লাই
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object === "page") {
    for (const entry of body.entry) {
      if (entry.messaging) {
        const event = entry.messaging[0];
        const senderId = event.sender.id;

        if (event.message?.attachments) {
          const attachment = event.message.attachments[0];
          if (attachment.type === "image") {
            pendingImages[senderId] = attachment.payload.url;
            return res.status(200).send("EVENT_RECEIVED"); 
          }
        }

        if (event.message?.text) {
          const userMessage = event.message.text;
          const savedImage = pendingImages[senderId] || null;
          
          const aiReply = await getGeminiResponse(userMessage, savedImage);
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
app.listen(PORT, () => console.log(`Free Bot running on port ${PORT}`));
