const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
require('dotenv').config();

const app = express();
app.use(express.json());

// Firebase Initialization
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = admin.firestore();
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = ai.getGenerativeModel({ model: 'gemini-pro' });

// WhatsApp Connection Function
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: Browsers.macOS('Desktop'),
        generateHighQualityLinkPreview: true
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) {
            console.log("\n[!] QR কোড জেনারেট হয়েছে! লগ থেকে স্ক্যান করুন:");
            require('qrcode-terminal').generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
        } else if (connection === 'open') {
            console.log("✅ হোয়াটসঅ্যাপ কানেক্টেড!");
        }
    });

    sock.ev.on('creds.update', saveCreds);
    global.whatsappSock = sock;
}

connectToWhatsApp();

// Webhook Handler
app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'page') {
        body.entry.forEach(async (entry) => {
            const event = entry.messaging[0];
            const senderId = event.sender.id;
            const userMsg = event.message.text;

            if (userMsg && userMsg.startsWith("wa/")) {
                const parts = userMsg.split("/");
                const number = parts[1];
                const text = parts.slice(2).join("/");
                if (global.whatsappSock && number && text) {
                    await global.whatsappSock.sendMessage(number + "@s.whatsapp.net", { text });
                }
            } else if (userMsg) {
                const result = await model.generateContent(userMsg);
                const reply = result.response.text();
                await axios.post(`https://graph.facebook.com/v20.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`, {
                    recipient: { id: senderId },
                    message: { text: reply }
                });
            }
        });
        res.status(200).send('EVENT_RECEIVED');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 সার্ভার চালু আছে পোর্ট ${PORT}-এ`));
