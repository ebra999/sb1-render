const express = require('express');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    useMultiFileAuthState,
    proto,
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

if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase URL and Key are required!');
}

const supabase = createClient(supabaseUrl, supabaseKey);
const logger = P({ level: 'silent' });

const SESSION_ID = 'main-session'; // معرف ثابت للجلسة

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());

let sock = null;
let isConnected = false;

// --- نظام المصادقة النهائي الذي يحفظ ويقرأ من Supabase بشكل صحيح ---
const useSupabaseAuthState = async (sessionId) => {
    const writeData = async (data) => {
        const dataString = JSON.stringify(data, BufferJSON.replacer);
        const { error } = await supabase.from('whatsapp_sessions').upsert({ id: sessionId, session_data: dataString });
        if (error) console.error('Error writing session to Supabase:', error);
    };

    const readData = async () => {
        const { data, error } = await supabase.from('whatsapp_sessions').select('session_data').eq('id', sessionId).single();
        if (error || !data) return null;
        return JSON.parse(data.session_data, BufferJSON.reviver);
    };

    const creds = await readData() || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: (type, ids) => {
                    const data = {};
                    ids.forEach(id => {
                        const value = creds.keys?.[type]?.[id];
                        if (value) {
                            if (type === 'app-state-sync-key') {
                                data[id] = proto.Message.AppStateSyncKeyData.fromObject(value);
                            } else {
                                data[id] = value;
                            }
                        }
                    });
                    return data;
                },
                set: (data) => {
                    for (const key in data) {
                        const type = key;
                        const value = data[key];
                        if (!creds.keys[type]) {
                            creds.keys[type] = {};
                        }
                        Object.assign(creds.keys[type], value);
                    }
                }
            }
        },
        saveCreds: () => writeData(creds)
    };
};


async function startWhatsAppConnection() {
    try {
        const { state, saveCreds } = await useSupabaseAuthState(SESSION_ID);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: state,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) qrcode.generate(qr, { small: true });
            if (connection === 'open') {
                isConnected = true;
                console.log('✅ تم الاتصال بواتساب بنجاح. الجلسة محفوظة الآن.');
            }
            if (connection === 'close') {
                isConnected = false;
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('❌ انقطع الاتصال، محاولة إعادة الاتصال:', shouldReconnect);
                if (shouldReconnect) {
                    startWhatsAppConnection();
                } else {
                    console.log('🚪 تم تسجيل الخروج.');
                }
            }
        });

    } catch (error) {
        console.error('❌ خطأ فادح في بدء الاتصال:', error);
    }
}

// --- نقاط النهاية (مع حل مشكلة التأخير) ---
app.get('/api/status', (req, res) => res.json({ success: true, isReady: isConnected }));
app.post('/api/send', (req, res) => { // لاحظ أننا أزلنا async من هنا
    try {
        const { number, message } = req.body;
        if (!isConnected || !sock) {
            return res.status(503).json({ success: false, message: 'الخدمة غير متاحة أو غير متصلة حالياً' });
        }
        const jid = number.replace(/\D/g, '') + '@s.whatsapp.net';
        
        // **الحل هنا: أزلنا await لإرسال الرد فوراً**
        sock.sendMessage(jid, { text: message });

        res.json({ success: true, message: 'تم استلام الطلب وجاري إرسال الرسالة' });

    } catch (error) {
        console.error("❌ Error sending message: ", error);
        res.status(500).json({ 
            success: false, 
            message: 'فشل إرسال الرسالة.',
            error: error.message
        });
    }
});
app.get('/', (req, res) => res.json({ service: "WhatsApp API", ready: isConnected }));

app.listen(PORT, () => {
    console.log(`🌐 الخادم يعمل على البورت ${PORT}`);
    startWhatsAppConnection();
});
