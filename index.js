const express = require('express');
const { 
    default: makeWASocket, 
    DisconnectReason,
    fetchLatestBaileysVersion,
    useMultiFileAuthState, // سنستخدم هذه الطريقة مع تعديل بسيط
    makeInMemoryStore,
    proto,
    BufferJSON
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

// --- نظام مخصص لإدارة الجلسة مع Supabase ---
const supabaseSession = (sessionId) => {
    const writeData = async (data, id) => {
        const dataString = JSON.stringify(data, BufferJSON.replacer);
        const { error } = await supabase
            .from('whatsapp_sessions')
            .upsert({ id: id, session_data: dataString }, { onConflict: 'id' });
        
        if (error) {
            console.error('Error writing session to Supabase:', error);
        }
    };

    const readData = async (id) => {
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('session_data')
            .eq('id', id)
            .single();

        if (error && error.code !== 'PGRST116') {
            console.error('Error reading session from Supabase:', error);
            return null;
        }
        
        if (data && data.session_data) {
            return JSON.parse(data.session_data, BufferJSON.reviver);
        }
        return null;
    };

    const removeData = async (id) => {
        const { error } = await supabase
            .from('whatsapp_sessions')
            .delete()
            .eq('id', id);
        if (error) {
            console.error('Error removing session from Supabase:', error);
        }
    };
    
    // محاكاة نظام الملفات في الذاكرة
    const creds = {};

    return {
        state: {
            creds: creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const key = `${type}-${id}`;
                        const cred = await readData(key);
                        if (cred) {
                             if (type === 'app-state-sync-key') {
                                data[id] = proto.Message.AppStateSyncKeyData.fromObject(cred);
                            } else {
                                data[id] = cred;
                            }
                        }
                    }
                    return data;
                },
                set: async (data) => {
                    for (const key in data) {
                        for (const id in data[key]) {
                            const value = data[key][id];
                            const file = `${key}-${id}`;
                            await writeData(value, file);
                        }
                    }
                },
            },
        },
        saveCreds: async () => {
            const sessionCreds = await readData(sessionId);
            await writeData(sessionCreds || creds, sessionId);
        },
    };
};


const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());

let sock = null;
let isConnected = false;

async function startWhatsAppConnection() {
    try {
        // --- استخدام الجلسة المحفوظة ---
        const { state, saveCreds } = await useMultiFileAuthState('whatsapp_session_local'); // We'll manage this manually
        
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
                    console.log('🚪 تم تسجيل الخروج. قم بحذف الجلسة من Supabase يدوياً إذا أردت مسح كود جديد');
                }
            }
        });

    } catch (error) {
        console.error('❌ خطأ في بدء الاتصال:', error);
        setTimeout(startWhatsAppConnection, 5000);
    }
}

// --- بقية الكود (نقاط النهاية) بدون تغيير ---

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
        version: "1.3.0-final",
        ready: isConnected
    });
});

function formatPhoneNumber(number) {
    let cleaned = number.replace(/\D/g, '');
    if (cleaned.length === 9 && !cleaned.startsWith('966')) {
        cleaned = '966' + cleaned;
    }
    return cleaned + '@s.whatsapp.net';
}

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
