const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
require('dotenv').config();

const app = express();
app.use(express.json());

// Firebase Initialize
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = admin.firestore();
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = ai.getGenerativeModel({ model: 'gemini-pro' });

// WhatsApp Logic
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        // গুরুত্বপূর্ণ: হোয়াটসঅ্যাপকে মোবাইল ব্রাউজার হিসেবে পরিচয় দেওয়া
        browser: Browsers.macOS('Desktop'),
        printQRInTerminal: false
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) {
            console.log("\n[QR CODE START]");
            require('qrcode-terminal').generate(qr, { small: true });
            console.log("[QR CODE END]\n");
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(connectToWhatsApp, 10000); // সময় বাড়িয়ে ১০ সেকেন্ড করা হয়েছে
        } else if (connection === 'open') {
            console.log("✅ হোয়াটসঅ্যাপ সাকসেসফুলি কানেক্টেড!");
        }
    });

    sock.ev.on('creds.update', saveCreds);
    global.whatsappSock = sock;
}

connectToWhatsApp();

// Webhook
app.post('/webhook', async (req, res) => {
    // আগের মেসেজ হ্যান্ডলিং লজিক...
    res.status(200).send('EVENT_RECEIVED');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 সার্ভার চালু আছে পোর্ট ${PORT}-এ`));
