const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
require('dotenv').config();

const app = express();
app.use(express.json());

// ------------------------------------------------------------------
// ১. ফায়ারবেস (Firebase) ইনিশিয়েলাইজেশন
// ------------------------------------------------------------------
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin SDK Initialized Successfully!");
    } catch (error) {
        console.error("❌ Firebase Initialization Error:", error.message);
    }
}
const db = admin.firestore();

// ------------------------------------------------------------------
// ২. জেমিনি এআই (Gemini AI) ইনিশিয়েলাইজেশন
// ------------------------------------------------------------------
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = ai.getGenerativeModel({ model: 'gemini-pro' });

// ------------------------------------------------------------------
// ৩. হোয়াটসঅ্যাপ桥 (WhatsApp Bridge) ইনিশিয়েলাইজেশন
// ------------------------------------------------------------------
global.whatsappSock = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("\n==============================================");
            console.log("👉 SCAN THIS QR CODE WITH YOUR WHATSAPP 👈");
            console.log("==============================================\n");
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ WhatsApp connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp User-Bot successfully connected!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
    global.whatsappSock = sock;
}

connectToWhatsApp();

// ------------------------------------------------------------------
// ৪. ফেসবুক মেসেঞ্জার ওয়েবহুক (Webhook Verification)
// ------------------------------------------------------------------
app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ Webhook Verified Successfully!');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// ------------------------------------------------------------------
// ৫. ফেসবুক থেকে মেসেজ রিসিভ এবং প্রসেস করা
// ------------------------------------------------------------------
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        body.entry.forEach(async (entry) => {
            const webhook_event = entry.messaging[0];
            if (!webhook_event || !webhook_event.message) return;

            const senderId = webhook_event.sender.id;
            const userMessage = webhook_event.message.text;

            if (!userMessage) return;

            console.log(`📩 New message from Facebook UI: ${userMessage}`);

            if (userMessage.startsWith("wa/")) {
                try {
                    const parts = userMessage.split("/");
                    const phoneNumber = parts[1] ? parts[1].trim() : null;
                    const whatsappMessage = parts.slice(2).join("/"); 

                    if (!phoneNumber || !whatsappMessage) {
                        await sendToFacebook(senderId, "❌ ফরম্যাট ভুল হয়েছে ভাই!\nসঠিক নিয়ম: wa/নাম্বার/মেসেজ\nউদাহরণ: wa/01988365533/হ্যালো");
                        return;
                    }

                    let formattedNumber = phoneNumber;
                    if (formattedNumber.startsWith("0")) {
                        formattedNumber = "880" + formattedNumber.substring(1);
                    } else if (!formattedNumber.startsWith("880")) {
                        formattedNumber = "880" + formattedNumber;
                    }
                    const jid = `${formattedNumber}@s.whatsapp.net`;

                    if (global.whatsappSock) {
                        await global.whatsappSock.sendMessage(jid, { text: whatsappMessage });
                        await sendToFacebook(senderId, `✅ সফল হয়েছে!\n${phoneNumber} নাম্বারে আপনার হোয়াটসঅ্যাপ মেসেজটি পাঠিয়ে দেওয়া হয়েছে। 😎`);
                    } else {
                        await sendToFacebook(senderId, "❌ হোয়াটসঅ্যাপ সার্ভারটি এই মুহূর্তে কানেক্টেড নেই। দয়া করে রেন্ডার লগ থেকে QR কোডটি আবার স্ক্যান করুন।");
                    }

                } catch (whatsappError) {
                    console.error("❌ WhatsApp Sending Error:", whatsappError);
                    await sendToFacebook(senderId, "❌ হোয়াটসঅ্যাপে মেসেজটি পাঠানো যায়নি। নাম্বারটি সঠিক আছে কি না চেক করুন।");
                }
            } 
            else {
                try {
                    const userDocRef = db.collection('chats').doc(senderId);
                    const doc = await userDocRef.get();
                    let chatHistory = [];

                    if (doc.exists) {
                        chatHistory = doc.data().history || [];
                    }

                    chatHistory.push({ role: 'user', parts: [{ text: userMessage }] });

                    const chat = model.startChat({ history: chatHistory });
                    const result = await chat.sendMessage(userMessage);
                    const aiReply = result.response.text();

                    chatHistory.push({ role: 'model', parts: [{ text: aiReply }] });
                    await userDocRef.set({ history: chatHistory }, { merge: true });

                    await sendToFacebook(senderId, aiReply);

                } catch (aiError) {
                    console.error("❌ Gemini/Firebase Error:", aiError.message);
                    await sendToFacebook(senderId, "দুঃখিত ভাই, আমার সার্ভারে একটু সমস্যা হচ্ছে। দয়া করে কিছুক্ষণ পর আবার চেষ্টা করুন।");
                }
            }
        });

        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

// ------------------------------------------------------------------
// ৬. ফেসবুকে মেসেজ ব্যাক পাঠানোর ফাংশন
// ------------------------------------------------------------------
async function sendToFacebook(senderId, text) {
    const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
    try {
        await axios.post(`https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id: senderId },
            message: { text: text }
        });
        console.log(`📤 Reply sent to Facebook user: ${senderId}`);
    } catch (error) {
        console.error("❌ Error sending message to Facebook:", error.response ? error.response.data : error.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server is live and listening on port ${PORT}`);
});
