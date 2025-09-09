const express = require('express');
const { 
    default: makeWASocket, 
    DisconnectReason,
    fetchLatestBaileysVersion,
    useSingleFileAuthState, // <- تم تغيير هذه
    BufferJSON,
    initAuthCreds
} = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal');
const { Boom } = require('@hapi/boom');
const P = require('pino');
require('dotenv').config();

// --- إعدادات Supabase ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const sessionId = process.env.SESSION_ID || 'my-whatsapp-session';

if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase URL and Key are required in environment variables!');
}

const supabase = createClient(supabaseUrl, supabaseKey);
const logger = P({ level: 'silent' });

// --- دالة مخصصة لإنشاء حالة المصادقة مع Supabase ---
const createSupabaseAuthState = async (sessionId) => {
    // قراءة الجلسة من قاعدة البيانات
    const { data: sessionData, error } = await supabase
        .from('whatsapp_sessions')
        .select('session_data')
        .eq('id', sessionId)
        .single();

    if (error && error.code !== 'PGRST116') { // تجاهل خطأ "عدم العثور على الصف"
        console.error('Error reading session from Supabase:', error);
    }
    
    // إما استخدام البيانات الموجودة أو إنشاء بيانات جديدة
    const creds = sessionData?.session_data ? JSON.parse(JSON.stringify(sessionData.session_data), BufferJSON.reviver) : initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = creds.keys[type]?.[id];
                            if (value) {
                                if (type === 'app-state-sync-key') {
                                    value = proto.Message.AppStateSyncKeyData.fromObject(value);
                                }
                                data[id] = value;
                            }
                        })
                    );
                    return data;
                },
                set: (data) => {
                    for (const key in data) {
                        const { [key]: value } = data;
                        if (!creds.keys[key]) {
                            creds.keys[key] = {};
                        }
                        Object.assign(creds.keys[key], value);
                    }
                },
            },
        },
        // دالة الحفظ التي سيتم استدعاؤها عند كل تحديث للجلسة
        saveCreds: async () => {
            const serializedCreds = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
            const { error: saveError } = await supabase
                .from('whatsapp_sessions')
                .upsert({ id: sessionId, session_data: serializedCreds }, { onConflict: 'id' });

            if (saveError) {
                console.error('Error saving session to Supabase:', saveError);
            }
        },
    };
};


const app = express();
const PORT = process.env.PORT || 10000; // Render uses port 10000
app.use(express.json());

let sock = null;
let isConnected = false;
let qrCodeGenerated = false;

async function startWhatsAppConnection() {
    try {
        const { state, saveCreds } = await createSupabaseAuthState(sessionId);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: state,
            generateHighQualityLinkPreview: false,
            shouldSyncHistoryMessage: () => false,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('\n📱 امسح رمز QR التالي بواتساب:');
                qrcode.generate(qr, { small: true });
                console.log('\n🔄 في انتظار المسح...\n');
            }
            
            if (connection === 'open') {
                console.log('✅ تم الاتصال بواتساب بنجاح');
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
        console.error('❌ خطأ في بدء الاتصال:', error);
        setTimeout(startWhatsAppConnection, 5000);
    }
}


// --- Routes (نقاط النهاية) ---
// ... (باقي الكود الخاص بالـ Routes يبقى كما هو بدون تغيير) ...

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
app.get('/', (req, res) => {
    res.json({
        service: "WhatsApp API with Supabase",
        version: "1.2.0",
        ready: isConnected
    });
});

// --- دوال مساعدة ---
function formatPhoneNumber(number) {
    let cleaned = number.replace(/\D/g, '');
    if (cleaned.length === 9 && !cleaned.startsWith('966')) {
        cleaned = '966' + cleaned;
    }
    return cleaned + '@s.whatsapp.net';
}

// --- بدء الخادم ---
async function startServer() {
    try {
        await startWhatsAppConnection();
        app.listen(PORT, () => {
            console.log(`🌐 الخادم يعمل الآن على البورت ${PORT}`);
            console.log(`💡 الجلسة تتم مزامنتها مع قاعدة بيانات Supabase.`);
        });
    } catch (error) {
        console.error('❌ فشل في بدء الخادم:', error);
        process.exit(1);
    }
}

startServer();
