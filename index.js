const express = require('express');
const { 
    default: makeWASocket, 
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    useCodeAuthentication
} = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal');
const { Boom } = require('@hapi/boom');
const P = require('pino');
require('dotenv').config();

// --- إعدادات Supabase ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const sessionId = process.env.SESSION_ID || 'my-whatsapp-session'; // معرف الجلسة

if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase URL and Key are required!');
}

const supabase = createClient(supabaseUrl, supabaseKey);
const logger = P({ level: 'silent' });

// --- دوال مخصصة لإدارة الجلسة مع Supabase ---
const supabaseSessionStore = {
    read: async (id) => {
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('session_data')
            .eq('id', id)
            .single();

        if (error && error.code !== 'PGRST116') { // PGRST116: row not found
            console.error('Error reading session from Supabase:', error);
            return null;
        }
        return data ? data.session_data : null;
    },
    write: async (id, data) => {
        const { error } = await supabase
            .from('whatsapp_sessions')
            .upsert({ id: id, session_data: data }, { onConflict: 'id' });

        if (error) {
            console.error('Error writing session to Supabase:', error);
        }
    },
    remove: async (id) => {
        const { error } = await supabase
            .from('whatsapp_sessions')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('Error removing session from Supabase:', error);
        }
    }
};

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

let sock = null;
let isConnected = false;
let qrCodeGenerated = false;

async function startWhatsAppConnection() {
    try {
        const { version } = await fetchLatestBaileysVersion();

        // --- استخدام الجلسة من Supabase ---
        const initialData = await supabaseSessionStore.read(sessionId);
        const { state, saveCreds } = await useCodeAuthentication(
            initialData || {},
            {
                write: (data) => supabaseSessionStore.write(sessionId, data),
                read: () => supabaseSessionStore.read(sessionId),
                remove: () => supabaseSessionStore.remove(sessionId),
            }
        );

        sock = makeWASocket({
            version,
            logger,
            auth: state,
            printQRInTerminal: false,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            markOnlineOnConnect: false,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && !qrCodeGenerated) {
                console.log('\n📱 امسح رمز QR التالي بواتساب:');
                qrcode.generate(qr, { small: true });
                console.log('\n🔄 في انتظار المسح...\n');
                qrCodeGenerated = true;
            }
            
            if (connection === 'open') {
                console.log('✅ تم الاتصال بواتساب بنجاح');
                isConnected = true;
                qrCodeGenerated = false;
            }
            
            if (connection === 'close') {
                isConnected = false;
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                
                console.log('❌ انقطع الاتصال:', lastDisconnect?.error);
                
                if (shouldReconnect) {
                    console.log('🔄 محاولة إعادة الاتصال...');
                    setTimeout(startWhatsAppConnection, 3000);
                } else {
                    console.log('🚪 تم تسجيل الخروج. يرجى حذف بيانات الجلسة من Supabase وإعادة تشغيل الخادم');
                    supabaseSessionStore.remove(sessionId); // حذف الجلسة عند تسجيل الخروج
                }
            }
        });

        sock.ev.on('messages.upsert', () => {});

    } catch (error) {
        console.error('❌ خطأ في بدء الاتصال:', error);
        setTimeout(startWhatsAppConnection, 5000);
    }
}

// ... (باقي الكود الخاص بالـ Routes يبقى كما هو بدون تغيير) ...

// Routes - نقاط النهاية
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        isReady: isConnected,
        message: isConnected ? 'الخدمة جاهزة' : 'في انتظار الاتصال'
    });
});
app.post('/api/send', async (req, res) => {
    try {
        const { number, message } = req.body;
        if (!number || !message) {
            return res.status(400).json({ success: false, message: 'رقم الهاتف والرسالة مطلوبان' });
        }
        if (!isConnected || !sock) {
            return res.status(503).json({ success: false, message: 'الخدمة غير متاحة. يرجى التأكد من الاتصال' });
        }
        const jid = formatPhoneNumber(number);
        const [result] = await sock.onWhatsApp(jid.split('@')[0]);
        if (!result?.exists) {
            return res.status(404).json({ success: false, message: 'رقم الهاتف غير موجود في واتساب' });
        }
        await sock.sendMessage(jid, { text: message });
        console.log(`✅ تم إرسال رسالة إلى: ${number}`);
        res.json({ success: true, message: 'تم إرسال الرسالة بنجاح' });
    } catch (error) {
        console.error('❌ خطأ في إرسال الرسالة:', error);
        res.status(500).json({ success: false, message: 'خطأ في إرسال الرسالة' });
    }
});
app.get('/', (req, res) => {
    res.json({
        service: 'WhatsApp API with Supabase',
        version: '1.1.0',
        ready: isConnected
    });
});
app.use((error, req, res, next) => {
    console.error('❌ خطأ عام:', error);
    res.status(500).json({ success: false, message: 'خطأ داخلي في الخادم' });
});
app.use('*', (req, res) => {
    res.status(404).json({ success: false, message: 'المسار غير موجود' });
});

// --- دوال مساعدة ---
function formatPhoneNumber(number) {
    let cleaned = number.replace(/\D/g, '');
    if (!cleaned.startsWith('966') && cleaned.length === 9) {
        cleaned = '966' + cleaned;
    }
    return cleaned + '@s.whatsapp.net';
}

// --- بدء الخادم ---
async function startServer() {
    try {
        console.log('🚀 جاري بدء خدمة واتساب...');
        await startWhatsAppConnection();
        app.listen(PORT, () => {
            console.log(`🌐 خادم API يعمل على البورت ${PORT}`);
            console.log('💡 الجلسة الآن محفوظة في قاعدة بيانات Supabase.');
        });
    } catch (error) {
        console.error('❌ فشل في بدء الخادم:', error);
        process.exit(1);
    }
}

startServer();
