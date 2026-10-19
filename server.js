const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'thisisaverylongandsecuresecretpassword12345';

// Security & Optimization Middleware Configurations
app.use(express.json());
app.use(cors());
app.use(helmet({
    contentSecurityPolicy: false, 
    crossOriginEmbedderPolicy: false
}));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP track, please try again later.'
});
app.use('/api/', limiter);

// Serve Static Front-End Layout Files Cleanly
app.use(express.static(path.join(__dirname, 'public')));

// Basic Application Health Metrics Ping
app.get('/api/health', (req, res) => {
    res.json({ status: "healthy", timestamp: new Date() });
});// --- LIVE MPESA INTEGRATION GATEWAY ---
const axios = require('axios');

// Safaricom Credentials (Using Sandbox details for testing)
// Safaricom Credentials (Official open test keys)
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || "ln7MstGGrGAdG7G7A7GfGGrGAdG7G7A7G";
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || "A7GfGGrGAdG7G7A7";
const MPESA_SHORTCODE = "174379"; // Official Sandbox shortcode
const MPESA_PASSKEY = "bfb27272bfb3c107e711487f5d47e33e2342440778a2214315d5434e7655a914";

// Middleware to generate M-Pesa Access Token
async function getMpesaToken(req, res, next) {
    const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
    try {
        const response = await axios.get('https://safaricom.co.ke', {
            headers: { Authorization: `Basic ${auth}` }
        });
        req.mpesaToken = response.data.access_token;
        next();
    } catch (error) {
        console.error("M-Pesa Token Error:", error.message);
        res.status(500).json({ error: "Failed to generate payment token" });
    }
}

// Route to Trigger the STK Push PIN Popup
app.post('/api/stkpush', getMpesaToken, async (req, res) => {
    const { phone, amount, accountId } = req.body;
    
    if (!phone || !amount) {
        return res.status(400).json({ error: "Phone number and amount parameters are required" });
    }
    
    // Format phone to 2547XXXXXXXX or 2541XXXXXXXX
    let formattedPhone = phone.trim().replace(/^\+/, '');
    if (formattedPhone.startsWith('0')) {
        formattedPhone = '254' + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) {
        formattedPhone = '254' + formattedPhone;
    }

    const date = new Date();
    const timestamp = date.getFullYear() +
        ("0" + (date.getMonth() + 1)).slice(-2) +
        ("0" + date.getDate()).slice(-2) +
        ("0" + date.getHours()).slice(-2) +
        ("0" + date.getMinutes()).slice(-2) +
        ("0" + date.getSeconds()).slice(-2);

    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
    const callbackUrl = `https://${req.get('host')}/api/mpesa-callback`;

    const stkData = {
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: Math.round(amount),
        PartyA: formattedPhone,
        PartyB: MPESA_SHORTCODE,
        PhoneNumber: formattedPhone,
        CallBackURL: callbackUrl,
        AccountReference: `Account_${accountId || 'Guest'}`,
        TransactionDesc: "Premium Package Activation"
    };

    try {
        const response = await axios.post('https://safaricom.co.ke', stkData, {
            headers: { Authorization: `Bearer ${req.mpesaToken}` }
        });
        res.json({ success: true, message: "STK Push sent successfully!", data: response.data });
    } catch (error) {
        console.error("STK Push Execution Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Payment dispatch failed" });
    }
});

// Callback Route: Listens for Safaricom's Success Message
app.post('/api/mpesa-callback', (req, res) => {
    const callbackData = req.body?.Body?.stkCallback;
    console.log("M-Pesa Callback Received:", JSON.stringify(callbackData || req.body));

    if (callbackData && callbackData.ResultCode === 0) {
        const metadataItems = callbackData.CallbackMetadata?.Item || [];
        const amountPaid = metadataItems.find(item => item.Name === "Amount")?.Value;
        const mpesaReceipt = metadataItems.find(item => item.Name === "MpesaReceiptNumber")?.Value;
        const userPhoneNumber = metadataItems.find(item => item.Name === "PhoneNumber")?.Value;

        console.log(`💰 SUCCESS: Payout verified for phone ${userPhoneNumber}. Amount: KSh ${amountPaid}. Receipt: ${mpesaReceipt}`);
    } else {
        console.log(`❌ CANCELLED: User cancelled or failed payment processing parameters.`);
    }

    res.json({ ResultCode: 0, ResultDesc: "Accepted Successfully" });
});

// Catch-All Route to serve frontend fallback links smoothly
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize Cloud Web Server Pipeline Listener
app.listen(PORT, () => {
    console.log(`🚀 Production Core Engine Online! Live on tracking station interface port: ${PORT}`);
});
