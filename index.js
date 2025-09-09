const express = require('express');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    useMultiFileAuthState, // سنستخدم هذه الدالة الأساسية
    makeInMemoryStore,
} = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal');
const { Boom } = require('@hapi/boom');
const P = require('pino');
require('dotenv').config();

// --- إعدادات Supabase ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase URL and Key are required!');
}

const supabase = createClient(supabaseUrl, supabaseKey);
const logger = P({ level: 'silent' });

// --- محول لتخزين الجلسة في Supabase بدلاً من الملفات ---
const supabaseStore = {
    writeToFile: async (path, data) => {
        const { error } = await supabase
            .from('whatsapp_sessions')
            .upsert({ id: path, session_data: data }, { onConflict: 'id' });

        if (error) {
            console.error('Error writing to Supabase:', path, error);
        }
    },
    readFromFile: async (path) => {
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('session_data')
            .eq('id', path)
            .single();

        if (error && error.code !== 'PGRST116') {
            console.error('Error reading from Supabase:', path, error);
        }
        return data ? data.session_data : null;
    },
    folderExists: async (path) => {
        // نتحقق من وجود ملف المصادقة الرئيسي
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('id')
            .eq('id', 'creds.json')
            .single();
        return !!data;
    }
};

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());

let sock = null;
let isConnected = false;

async function startWhatsAppConnection() {
    try {
        // نستخدم دالة المكتبة الرسمية مع المحول المخصص
        const { state, saveCreds } = await useMultiFileAuthState(
            'whatsapp_session', // اسم المجلد الوهمي
            supabaseStore // المحول الخاص بنا
        );
        
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: state,
            generateHighQualityLinkPreview: false,
            shouldSyncHistoryMessage: () => false,
        });

        // هذا الحدث سيقوم الآن بالحفظ في Supabase تلقائياً
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('\n📱 امسح رمز QR (هذه ستكون المرة الأخيرة بإذن الله):');
                qrcode.generate(qr, { small: true });
            }
            
            if (connection === 'open') {
                console.log('✅ تم الاتصال بواتساب بنجاح. الجلسة محفوظة الآن.');
                isConnected = true;
            }
            
            if (connection === 'close') {
                isConnected = false;
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                
                console.log('❌ انقطع الاتصال بسبب:', lastDisconnect?.error, ', محاولة إعادة الاتصال:', shouldReconnect);
                
                if (shouldReconnect) {
                    setTimeout(startWhatsAppConnection, 5000);
                } else {
                    console.log('🚪 تم تسجيل الخروج. لن تتم إعادة الاتصال.');
                }
            }
        });

    } catch (error) {
        console.error('❌ خطأ فادح في بدء الاتصال:', error);
        setTimeout(startWhatsAppConnection, 5000);
    }
}

// --- نقاط النهاية (تبقى كما هي) ---
app.get('/api/status', (req, res) => res.json({ success: true, isReady: isConnected, message: isConnected ? 'الخدمة جاهزة' : 'في انتظار الاتصال' }));

app.post('/api/send', async (req, res) => {
    try {
        const { number, message } = req.body;
        if (!number || !message) return res.status(400).json({ success: false, message: 'رقم الهاتف والرسالة مطلوبان' });
        if (!isConnected || !sock) return res.status(503).json({ success: false, message: 'الخدمة غير متاحة' });
        
        const jid = formatPhoneNumber(number);
        const [result] = await sock.onWhatsApp(jid.split('@')[0]);
        if (!result?.exists) return res.status(404).json({ success: false, message: 'رقم الهاتف غير موجود في واتساب' });

        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'تم إرسال الرسالة بنجاح' });
    } catch (error) {
        console.error('❌ خطأ في إرسال الرسالة:', error);
        res.status(500).json({ success: false, message: 'خطأ في إرسال الرسالة' });
    }
});

app.get('/', (req, res) => res.json({ service: "WhatsApp API", version: "2.0.0-stable", ready: isConnected }));

function formatPhoneNumber(number) {
    let cleaned = number.replace(/\D/g, '');
    if (cleaned.length === 9 && !cleaned.startsWith('966')) { cleaned = '966' + cleaned; }
    return cleaned + '@s.whatsapp.net';
}

async function startServer() {
    try {
        await startWhatsAppConnection();
        app.listen(PORT, () => console.log(`🌐 الخادم يعمل على البورت ${PORT}`));
    } catch (error) {
        console.error('❌ فشل في بدء الخادم:', error);
        process.exit(1);
    }
}

startServer();
