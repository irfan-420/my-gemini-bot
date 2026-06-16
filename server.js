const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const { default: makeWASocket, BufferJSON, initAuthCreds, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
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
// ৩. ফায়ারবেস হোয়াটসঅ্যাপ সেশন হ্যান্ডলার
// ------------------------------------------------------------------
async function useFirebaseAuthState() {
    const collectionRef = db.collection('whatsapp_session');
    
    let creds;
    try {
        const credsDoc = await collectionRef.doc('creds').get();
        if (credsDoc.exists && credsDoc.data().data) {
            creds = JSON.parse(credsDoc.data().data, BufferJSON.reviver);
        } else {
            console.log("ℹ️ No previous session found in Firebase. Creating new credentials...");
            creds = initAuthCreds();
        }
    } catch (err) {
        console.log("⚠️ Database empty, initializing fresh credentials...");
        creds = initAuthCreds();
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        try {
                            const doc = await collectionRef.doc(`${type}-${id}`).get();
                            if (doc.exists && doc.data().data) {
                                data[id] = JSON.parse(doc.data().data, BufferJSON.reviver);
                            }
                        } catch (e) {
                            // ইগনোর করবে
                        }
                    }
                    return data;
                },
                set: async (data) => {
                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            const docRef = collectionRef.doc(`${type}-${id}`);
                            try {
                                if (value) {
                                    await docRef.set({ data: JSON.stringify(value, BufferJSON.replacer) });
                                } else {
                                    await docRef.delete();
                                }
                            } catch (e) {
                                console.error("❌ Error writing auth keys to Firebase:", e.message);
                            }
                        }
                    }
                }
            }
        },
        saveCreds: async () => {
            try {
                await collectionRef.doc('creds').set({ data: JSON.stringify(creds, BufferJSON.replacer) });
            } catch (e) {
                console.error("❌ Error saving main creds to Firebase:", e.message);
            }
        }
    };
}

// ------------------------------------------------------------------
// ৪. হোয়াটসঅ্যাপ ব্রিজ (WhatsApp Bridge - নেটওয়ার্ক বাইপাস সহ)
// ------------------------------------------------------------------
global.whatsappSock = null;

async function connectToWhatsApp() {
    console.log("⏳ Fetching WhatsApp Auth State from Firebase...");
    const { state, saveCreds } = await useFirebaseAuthState();
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        // 🌟 সার্ভার নেটওয়ার্ক বাইপাস করার জন্য ক্রোম ব্রাউজার ডিক্লেয়ারেশন
        browser: Browsers.macOS('Chrome'),
        connectTimeoutMs: 60000, // সার্ভার স্লো হলেও যেন টাইমআউট না হয় (১ মিনিট টাইম)
        keepAliveIntervalMs: 30000
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
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`❌ WhatsApp connection closed. Reason: ${lastDisconnect.error?.message || 'Network Drop'} (Status: ${statusCode})`);
            
            if (shouldReconnect) {
                console.log('🔄 Attempting to re-establish bridge in 5 seconds...');
                setTimeout(connectToWhatsApp, 5000);
            }
        } else if (connection === 'open') {
            console.log('============== ✨ SUCCESS ✨ ==============');
            console.log('✅ WhatsApp User-Bot successfully connected!');
            console.log('===========================================');
        }
    });

    sock.ev.on('creds.update', saveCreds);
    global.whatsappSock = sock;
}

// হোয়াটসঅ্যাপ কানেকশন স্টার্ট করা
connectToWhatsApp();

// ------------------------------------------------------------------
// ৫. ফেসবুক মেসেঞ্জার ওয়েবহুক (Webhook Verification)
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
// ৬. ফেসবুক থেকে মেসেজ রিসিভ এবং প্রসেস করা
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
// ৭. ফেসবুকে মেসেজ ব্যাক পাঠানোর ফাংশন
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
