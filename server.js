const express = require("express");
const app = express();

// ইনকামিং ডাটা রিড করার জন্য মিডলওয়্যার
app.use(express.json());

// হোম রুট (সার্ভার লাইভ আছে কি না চেক করার জন্য)
app.get("/", (req, res) => {
  res.send("আইটি সচল আছে! আপনার ফেসবুক বট সার্ভার সফলভাবে রান করছে।");
});

// ফেসবুক মেসেঞ্জার ভেরিফিকেশন (GET Request)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      console.log("WEBHOOK_VERIFIED");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// মেসেজ রিসিভ এবং জেমিনি দিয়ে রিপ্লাই (POST Request)
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object === "page") {
    body.entry.forEach(async function(entry) {
      if (!entry.messaging || entry.messaging.length === 0) return;
      
      const webhook_event = entry.messaging[0];
      
      if (webhook_event && webhook_event.message && webhook_event.message.text) {
        const sender_psid = webhook_event.sender.id;
        const user_message = webhook_event.message.text;

        console.log(`User Said: ${user_message}`);

        // জেমিনি এআই থেকে উত্তর নেওয়া
        const ai_reply = await getGeminiResponse(user_message);

        // ফেসবুকে রিপ্লাই পাঠানো
        sendFacebookMessage(sender_psid, ai_reply);
      }
    });
    res.status(200).send("EVENT_RECEIVED");
  } else {
    res.sendStatus(404);
  }
});

// জেমিনি এআই ফাংশন (Gemini 1.5 Flash ব্যবহার করা হয়েছে)
async function getGeminiResponse(prompt) {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await response.json();
    
    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
      return data.candidates[0].content.parts[0].text;
    } else {
      console.error("Gemini Unexpected Response:", JSON.stringify(data));
      return "দুঃখিত ভাই, আমি বিষয়টি বুঝতে পারিনি। আবার একটু গুছিয়ে লিখবেন কি?";
    }
  } catch (error) {
    console.error("Gemini Error:", error);
    return "দুঃখিত ভাই, আমার সার্ভারে একটু সমস্যা হচ্ছে। দয়া করে আবার চেষ্টা করুন!";
  }
}

// ফেসবুকে মেসেজ পাঠানোর ফাংশন
async function sendFacebookMessage(sender_psid, text_reply) {
  const payload = {
    recipient: { id: sender_psid },
    message: { text: text_reply }
  };

  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (data.error) {
      console.error("FB Send Error Response:", data.error);
    } else {
      console.log("Reply sent successfully!");
    }
  } catch (error) {
    console.error("FB Send Fetch Error:", error);
  }
}

// সার্ভার পোর্ট সেটিংস
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Your bot server is running on port " + PORT);
});
