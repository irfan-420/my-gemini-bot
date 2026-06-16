const express = require("express");
const admin = require("firebase-admin");
const app = express();

app.use(express.json());

// --- [ফায়ারবেস ফায়ারস্টোর কানেকশন সেটআপ] ---
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("[Firebase] Persistent Memory Connected Successfully!");
  } else {
    console.log("[Firebase] Warning: FIREBASE_SERVICE_ACCOUNT env variable is missing.");
  }
} catch (err) {
  console.error("[Firebase Init Error]:", err.message);
}

const db = admin.firestore();
let pendingImages = {}; 

app.get("/", (req, res) => {
  res.send("বট সার্ভার সচল আছে! (Serper Search Engine & Firebase Persistent Memory Active)");
});

// ফেসবুক মেসেঞ্জার ওয়েব হুক ভেরিফিকেশন (GET)
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
  if (!process.env.SERPER_API_KEY) {
    console.log("[Search] SERPER_API_KEY missing. Skipping live search.");
    return null;
  }

  try {
    console.log(`[Search] Fetching live results for: ${query}`);
    
    let finalQuery = query;
    // খেলা সম্পর্কিত সার্চগুলোকে আরও নিখুঁত করার লজিক
    if (query.includes("খেলা") || query.includes("ম্যাচ") || query.includes("ওয়ার্ল্ড কাপ")) {
      finalQuery = `${query} matches schedule today football live score`;
    }

    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ q: finalQuery, num: 10 }) // ১০টি ওয়েবসাইট স্ক্যান করবে
    });

    if (!response.ok) return null;

    const data = await response.json();
    let searchResults = "";
    
    // গুগলের ডিরেক্ট অ্যান্সার বক্স থাকলে সেটা আগে নেবে
    if (data.answerBox) {
      searchResults += `Answer Box: ${data.answerBox.title || ''} - ${data.answerBox.answer || data.answerBox.snippet || ''}\n`;
    }

    if (data.organic && data.organic.length > 0) {
      data.organic.slice(0, 8).forEach((item, index) => {
        searchResults += `${index + 1}. ${item.title}: ${item.snippet}\n`;
      });
      return searchResults;
    }
    return null;
  } catch (error) {
    console.error("[Search Error]:", error.message);
    return null;
  }
}

// জেমিনি এপিআই কল করার কোর ফাংশন
async function callGemini(modelId, history, prompt, imageUrl, liveSearchContext) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 18000); // ১৮ সেকেন্ড টাইমআউট

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    let currentParts = [];
    
    // ইমেজ এটাচমেন্ট প্রসেসিং লজিক
    if (imageUrl) {
      try {
        const imgResponse = await fetch(imageUrl);
        if (imgResponse.ok) {
          const arrayBuffer = await imgResponse.arrayBuffer();
          const base64Data = Buffer.from(arrayBuffer).toString("base64");
          const contentType = imgResponse.headers.get("content-type") || "image/jpeg";
          currentParts.push({ inlineData: { mimeType: contentType, data: base64Data } });
        }
      } catch (err) {
        console.error("Image error:", err.message);
      }
    }
    
    currentParts.push({ text: prompt });
    // আগের চ্যাট হিস্টোরির সাথে বর্তমান মেসেজ মার্জ করা হচ্ছে
    let contentsPayload = [...history, { role: "user", parts: currentParts }];
    
    // সার্ভারের বর্তমান তারিখ ও বার বের করা
    const today = new Date().toLocaleDateString('bn-BD', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
    });
    
    // সিস্টেম ইনস্ট্রাকশন সেটআপ (সার্চ রেজাল্ট প্রম্পট আলাদা রাখার ট্রিক)
    let systemNotice = `তুমি একটি ফেসবুক মেসেঞ্জার এআই অ্যাসিস্ট্যান্ট। আজকের সঠিক তারিখ ও বার হলো ${today}।`;
    if (liveSearchContext) {
      systemNotice += ` ইন্টারনেট থেকে সংগৃহীত রিয়েল-টাইম লাইভ তথ্য নিচে দেওয়া হলো। এখান থেকে আজকের নির্দিষ্ট ম্যাচের তালিকা, সময়সূচী ও স্কোর ফিল্টার করে ব্যবহারকারীকে বাংলায় একদম স্পষ্ট ও নির্ভুল তালিকা আকারে উত্তর দাও। কোনো তথ্য না থাকলে মনগড়া কিছু বলবে না।\n\nলাইভ তথ্য:\n${liveSearchContext}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        contents: contentsPayload,
        systemInstruction: { parts: [{ text: systemNotice }] }
      }),
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

// মূল রেসপন্স হ্যান্ডলার (ফায়ারবেস রিড এবং রাইট প্রসেসসহ)
async function getGeminiResponse(senderId, prompt, imageUrl) {
  let history = [];
  const docRef = db.collection("messenger_chats").doc(senderId);

  // ১. ফায়ারবেস থেকে ইউজারের আগের চ্যাট হিস্টোরি রিড করা
  try {
    const doc = await docRef.get();
    if (doc.exists) {
      history = doc.data().history || [];
    }
  } catch (dbErr) {
    console.error("[Firebase Read Error]:", dbErr.message);
  }
  
  let liveSearchContext = null;
  const lowerPrompt = prompt.toLowerCase();
  
  // নির্দিষ্ট কিওয়ার্ড ম্যাচ করলে লাইভ সার্চ রান হবে
  if (imageUrl == null && (lowerPrompt.includes("খবর") || lowerPrompt.includes("আজকে") || lowerPrompt.includes("তারিখ") || lowerPrompt.includes("স্কোর") || lowerPrompt.includes("weather") || lowerPrompt.includes("আবহাওয়া") || lowerPrompt.includes("কে জিতেছে") || lowerPrompt.includes("কত") || lowerPrompt.includes("বর্তমান") || lowerPrompt.includes("খেলা") || lowerPrompt.includes("ম্যাচ"))) {
    liveSearchContext = await searchGoogleLive(prompt);
  }

  console.log(`[Process] Requesting Primary Model (gemini-3.5-flash)...`);
  let reply = await callGemini("gemini-3.5-flash", history, prompt, imageUrl, liveSearchContext);
  
  // ব্যাকআপ ফলব্যাক মডেল চেইনিং
  if (!reply) {
    console.log(`[Fallback] Switching to Backup Model (gemini-3.1-flash-lite)...`);
    reply = await callGemini("gemini-3.1-flash-lite", history, prompt, imageUrl, liveSearchContext);
  }

  if (!reply) {
    return "দুঃখিত ভাই, এই মুহূর্তে সার্ভারে অতিরিক্ত চাপ রয়েছে। দয়া করে একটু পর আবার চেষ্টা করুন।";
  }

  // ২. নতুন চ্যাট হিস্টোরি আপডেট করে ফায়ারবেসে রাইট করা
  try {
    history.push({ role: "user", parts: [{ text: prompt }] });
    history.push({ role: "model", parts: [{ text: reply }] });

    // টোকেন লিমিট বাঁচাতে এবং মেমরি ক্লিন রাখতে শেষ ১০০টি মেসেজ (৫০ জোড়া কথোপকথন) রাখবে
    if (history.length > 100) {
      history = history.slice(-100);
    }

    await docRef.set({ history }, { merge: true });
    console.log(`[Firebase] Chat history saved for user: ${senderId}`);
  } catch (dbErr) {
    console.error("[Firebase Write Error]:", dbErr.message);
  }

  return reply;
}

// ফেসবুক মেসেজ রিসিভ এবং সেন্ড হ্যান্ডলার (POST)
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object === "page") {
    for (const entry of body.entry) {
      if (entry.messaging) {
        const event = entry.messaging[0];
        const senderId = event.sender.id;

        // ইমেজ অ্যাটাচমেন্ট হ্যান্ডলার
        if (event.message?.attachments) {
          const attachment = event.message.attachments[0];
          if (attachment.type === "image") {
            pendingImages[senderId] = attachment.payload.url;
            return res.status(200).send("EVENT_RECEIVED"); 
          }
        }

        // টেক্সট মেসেজ হ্যান্ডলার
        if (event.message?.text) {
          const userMessage = event.message.text;
          const savedImage = pendingImages[senderId] || null;
          
          // রেসপন্স জেনারেট করা (senderId সহ)
          const aiReply = await getGeminiResponse(senderId, userMessage, savedImage);
          pendingImages[senderId] = null; // ইমেজ ক্যাশ ক্লিয়ার

          // ফেসবুক গ্রাফ এপিআই-এর মাধ্যমে রিপ্লাই পাঠানো
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
app.listen(PORT, () => console.log(`SuperNinja Persistent AI Bot running on port ${PORT}`));
