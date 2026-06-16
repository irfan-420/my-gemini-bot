const express = require("express");
const app = express();

app.use(express.json());

// ছবি মনে রাখার জন্য মেমোরি
let pendingImages = {}; 

app.get("/", (req, res) => {
  res.send("বট সার্ভার সচল আছে! (3.5 + 3.1 Flash Lite + Google Live Search Perfected)");
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

// এপিআই কল করার হেল্পার ফাংশন (টাইমআউট, ফলব্যাক এবং সঠিক গুগল সার্চসহ)
async function callGemini(modelId, prompt, imageUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 18000); // সার্চ এবং ডাউনলোডের জন্য ১৮ সেকেন্ড টাইমআউট

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    let parts = [];
    
    // যদি মেমোরিতে ছবি থাকে, তবে সেটি ডাউনলোড করে Base64 এ রূপান্তর করা হচ্ছে
    if (imageUrl) {
      try {
        const imgResponse = await fetch(imageUrl);
        if (imgResponse.ok) {
          const arrayBuffer = await imgResponse.arrayBuffer();
          const base64Data = Buffer.from(arrayBuffer).toString("base64");
          const contentType = imgResponse.headers.get("content-type") || "image/jpeg";
          
          parts.push({
            inlineData: {
              mimeType: contentType,
              data: base64Data
            }
          });
          console.log(`[Success] Image processed for ${modelId}`);
        } else {
          console.error(`[Error] Failed to download Facebook image. Status: ${imgResponse.status}`);
        }
      } catch (imgErr) {
        console.error("[Error] Image conversion failed:", imgErr.message);
      }
    }
    
    // টেক্সট প্রম্পট পুশ করা হচ্ছে
    parts.push({ text: prompt });

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        contents: [{ parts: parts }],
        // এখানে একদম সঠিক গুগল সার্চ গ্রাউন্ডিং সিনট্যাক্স ব্যবহার করা হয়েছে
        tools: [{ googleSearchRetrieval: {} }] 
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Gemini API Error] ${modelId} returned status ${response.status}: ${errText}`);
      return null; 
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`[Catch Error] ${modelId} failed:`, error.message);
    return null; 
  }
}

// মূল ফাংশন যেখানে ৩.৫ এবং ৩.১ এর চেইন লজিক আছে
async function getGeminiResponse(prompt, imageUrl) {
  console.log(`[Process] Requesting gemini-3.5-flash...`);
  let reply = await callGemini("gemini-3.5-flash", prompt, imageUrl);
  if (reply) return reply;

  console.log(`[Fallback] gemini-3.5-flash failed. Trying gemini-3.1-flash-lite...`);
  reply = await callGemini("gemini-3.1-flash-lite", prompt, imageUrl);
  if (reply) return reply;

  // দুটি মডেলই সম্পূর্ণ ব্যর্থ হলে এই মেসেজ যাবে
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

        // ছবি সনাক্তকরণ লজিক
        if (event.message?.attachments) {
          const attachment = event.message.attachments[0];
          if (attachment.type === "image") {
            pendingImages[senderId] = attachment.payload.url;
            console.log(`[Memory] Image saved for user: ${senderId}`);
            return res.status(200).send("EVENT_RECEIVED"); // ছবি পেলে বট সম্পূর্ণ চুপ থাকবে
          }
        }

        // টেক্সট প্রশ্ন সনাক্তকরণ লজিক
        if (event.message?.text) {
          const userMessage = event.message.text;
          const savedImage = pendingImages[senderId] || null;
          
          // জেমিনি থেকে ফাইনাল রেসপন্স নেওয়া
          const aiReply = await getGeminiResponse(userMessage, savedImage);
          
          // উত্তর জেনারেট হওয়ার সাথে সাথে ইমেজ মেমোরি খালি করা
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
app.listen(PORT, () => console.log(`Bot successfully running on port ${PORT}`));
