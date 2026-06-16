const express = require("express");
const app = express();

app.use(express.json());

// ছবি মনে রাখার জন্য সাময়িক মেমোরি
let pendingImages = {}; 

app.get("/", (req, res) => {
  res.send("বট সার্ভার সচল আছে! (Serper Live Search & Flash Fallback System Active)");
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

// --- [Serper.dev লাইভ গুগল সার্চ ফাংশন] ---
async function searchGoogleLive(query) {
  // রেন্ডার ড্যাশবোর্ড থেকে এপিআই কি চেক করা হচ্ছে
  if (!process.env.SERPER_API_KEY) {
    console.log("[Search] SERPER_API_KEY missing in Environment Variables. Skipping search.");
    return null;
  }

  try {
    console.log(`[Search] Fetching live results for: ${query}`);
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY,
        "Content-Type": "application/json"
      },
      // gl: "bd" (বাংলাদেশ) এবং hl: "bn" (বাংলা) দিয়ে লোকাল রেজাল্ট নিখুঁত করা হয়েছে
      body: JSON.stringify({ q: query, gl: "bd", hl: "bn" }) 
    });

    if (!response.ok) {
      console.error(`[Search Error] Serper API status: ${response.status}`);
      return null;
    }

    const data = await response.json();
    let searchResults = "";
    
    // সেরা ৪টি সার্চ রেজাল্টের টাইটেল এবং সারসংক্ষেপ (Snippet) একসাথে জোড়া হচ্ছে
    if (data.organic && data.organic.length > 0) {
      data.organic.slice(0, 4).forEach((item, index) => {
        searchResults += `${index + 1}. ${item.title}: ${item.snippet}\n`;
      });
      return searchResults;
    }
    return null;
  } catch (error) {
    console.error("[Search Error] Failed to fetch Google Search:", error.message);
    return null;
  }
}

// এপিআই কল করার হেল্পার ফাংশন
async function callGemini(modelId, prompt, imageUrl, liveSearchContext) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 18000); // ১৮ সেকেন্ড টাইমআউট

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    let parts = [];
    
    // ফেসবুকের ছবি প্রসেস এবং ডাউনলোড লজিক
    if (imageUrl) {
      try {
        const imgResponse = await fetch(imageUrl);
        if (imgResponse.ok) {
          const arrayBuffer = await imgResponse.arrayBuffer();
          const base64Data = Buffer.from(arrayBuffer).toString("base64");
          const contentType = imgResponse.headers.get("content-type") || "image/jpeg";
          
          parts.push({
            inlineData: { mimeType: contentType, data: base64Data }
          });
          console.log(`[Success] Image processed for ${modelId}`);
        }
      } catch (imgErr) {
        console.error("[Error] Image conversion failed:", imgErr.message);
      }
    }
    
    // সার্ভার থেকে আজকের সঠিক তারিখ বের করা
    const today = new Date().toLocaleDateString('bn-BD', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
    });
    
    // প্রম্পট ইঞ্জিনিয়ারিং: লাইভ সার্চের ডেটা প্রম্পটে সুন্দরভাবে ইনজেক্ট করা হচ্ছে
    let systemNotice = `[সিস্টেম নোটিশ: আজকের তারিখ ও বার হলো ${today}।`;
    if (liveSearchContext) {
      systemNotice += ` ইন্টারনেট থেকে পাওয়া লাইভ সার্চ রেজাল্ট নিচে দেওয়া হলো, এটার ওপর ভিত্তি করে একদম লেটেস্ট ও সঠিক উত্তর দাও।\n\nলাইভ তথ্য:\n${liveSearchContext}`;
    }
    systemNotice += `]`;

    const fullPrompt = `${systemNotice}\n\nব্যবহারকারীর প্রশ্ন: ${prompt}`;
    parts.push({ text: fullPrompt });

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: parts }] }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    if (!response.ok) return null; 

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (error) {
    clearTimeout(timeoutId);
    return null; 
  }
}

// ৩.৫ এবং ৩.১ এর ফলব্যাক ও চেইনিং মেকানিজম
async function getGeminiResponse(prompt, imageUrl) {
  let liveSearchContext = null;
  const lowerPrompt = prompt.toLowerCase();
  
  // ফিল্টারিং: শুধুমাত্র দরকারি বা সাম্প্রতিক তথ্যের প্রশ্নের জন্যই গুগল সার্চ রান হবে
  if (imageUrl == null && (lowerPrompt.includes("খবর") || lowerPrompt.includes("আজকে") || lowerPrompt.includes("তারিখ") || lowerPrompt.includes("স্কোর") || lowerPrompt.includes("weather") || lowerPrompt.includes("আবহাওয়া") || lowerPrompt.includes("কে জিতেছে") || lowerPrompt.includes("কত") || lowerPrompt.includes("বর্তমান"))) {
    liveSearchContext = await searchGoogleLive(prompt);
  }

  console.log(`[Process] Requesting gemini-3.5-flash...`);
  let reply = await callGemini("gemini-3.5-flash", prompt, imageUrl, liveSearchContext);
  if (reply) return reply;

  console.log(`[Fallback] gemini-3.5-flash failed. Trying gemini-3.1-flash-lite...`);
  reply = await callGemini("gemini-3.1-flash-lite", prompt, imageUrl, liveSearchContext);
  if (reply) return reply;

  return "দুঃখিত ভাই, সার্ভারে অতিরিক্ত চাপের কারণে উত্তর দিতে পারছি না। দয়া করে একটু পর আবার চেষ্টা করুন।";
}

// ফেসবুক মেসেজ হ্যান্ডলার
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object === "page") {
    for (const entry of body.entry) {
      if (entry.messaging) {
        const event = entry.messaging[0];
        const senderId = event.sender.id;

        // ছবি সনাক্তকরণ (ছবি পেলে বট চুপ থাকবে)
        if (event.message?.attachments) {
          const attachment = event.message.attachments[0];
          if (attachment.type === "image") {
            pendingImages[senderId] = attachment.payload.url;
            return res.status(200).send("EVENT_RECEIVED"); 
          }
        }

        // টেক্সট মেসেজ আসলে রিপ্লাই দেওয়া
        if (event.message?.text) {
          const userMessage = event.message.text;
          const savedImage = pendingImages[senderId] || null;
          
          const aiReply = await getGeminiResponse(userMessage, savedImage);
          pendingImages[senderId] = null; // কাজ শেষে ইমেজ মেমোরি খালি করা

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
