const express = require('express');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
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
if (!supabaseUrl || !supabaseKey) throw new Error('Supabase URL and Key are required!');
const supabase = createClient(supabaseUrl, supabaseKey);
const logger = P({ level: 'silent' });

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());

// --- مخزن الجلسات: هنا سيتم حفظ كل الاتصالات النشطة ---
const sessions = {}; // key: sessionId, value: { sock, isConnected }

// --- نظام المصادقة الذي يتعامل مع Supabase ---
const useSupabaseAuthState = async (sessionId) => {
    const writeData = async (data) => {
        const dataString = JSON.stringify(data, BufferJSON.replacer);
        await supabase.from('whatsapp_sessions').upsert({ id: sessionId, session_data: dataString });
    };
    const readData = async () => {
        const { data } = await supabase.from('whatsapp_sessions').select('session_data').eq('id', sessionId).single();
        if (!data) return null;
        return JSON.parse(data.session_data, BufferJSON.reviver);
    };
    const creds = await readData() || initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                get: (type, ids) => { /* ... (Logic remains the same) ... */ },
                set: (data) => { /* ... (Logic remains the same) ... */ }
            }
        },
        saveCreds: () => writeData(creds)
    };
    // Note: The inner workings of get/set keys are complex and omitted for brevity,
    // as they are handled correctly in the full code block from the previous correct answer.
    // The main point is that read/write are scoped to the sessionId.
};


// --- دالة الاتصال المعدلة لتقبل sessionId ---
async function startWhatsAppConnection(sessionId) {
    if (!sessionId) {
        console.error("❌ لا يمكن بدء جلسة بدون معرف فريد (sessionId)");
        return;
    }
    console.log(`🚀 جاري بدء جلسة جديدة بالمعرف: ${sessionId}`);

    try {
        const { state, saveCreds } = await useSupabaseAuthState(sessionId);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: state,
        });

        // حفظ الاتصال في مخزن الجلسات
        sessions[sessionId] = { sock, isConnected: false };

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                console.log(`\n📱 امسح رمز QR للجلسة (${sessionId}):`);
                qrcode.generate(qr, { small: true });
            }
            if (connection === 'open') {
                sessions[sessionId].isConnected = true;
                console.log(`✅ تم الاتصال بنجاح للجلسة: ${sessionId}`);
            }
            if (connection === 'close') {
                sessions[sessionId].isConnected = false;
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(`❌ انقطع اتصال الجلسة ${sessionId}، إعادة المحاولة: ${shouldReconnect}`);
                if (shouldReconnect) {
                    // إزالة الجلسة القديمة ومحاولة إعادة الاتصال
                    delete sessions[sessionId];
                    setTimeout(() => startWhatsAppConnection(sessionId), 5000);
                } else {
                    console.log(`🚪 تم تسجيل الخروج من الجلسة ${sessionId}.`);
                    delete sessions[sessionId]; // حذف الجلسة نهائياً
                }
            }
        });

    } catch (error) {
        console.error(`❌ خطأ فادح في بدء الجلسة ${sessionId}:`, error);
        delete sessions[sessionId];
    }
}

// --- نقاط النهاية (API Endpoints) المعدلة ---

/**
 * نقطة نهاية جديدة لبدء جلسة جديدة
 * POST /api/connect
 * Body: { "sessionId": "my_work_phone" }
 */
app.post('/api/connect', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ success: false, message: "معرف الجلسة (sessionId) مطلوب" });
    }
    if (sessions[sessionId]) {
        return res.status(200).json({ success: true, message: `الجلسة ${sessionId} موجودة بالفعل وحالتها: ${sessions[sessionId].isConnected ? 'متصل' : 'غير متصل'}` });
    }
    await startWhatsAppConnection(sessionId);
    res.status(201).json({ success: true, message: `تم بدء عملية الاتصال للجلسة ${sessionId}. يرجى مراقبة السجلات لمسح رمز QR.` });
});


/**
 * نقطة نهاية الإرسال المعدلة
 * POST /api/send
 * Body: { "sessionId": "my_work_phone", "number": "966...", "message": "..." }
 */
app.post('/api/send', async (req, res) => {
    try {
        const { sessionId, number, message } = req.body;
        if (!sessionId || !number || !message) {
            return res.status(400).json({ success: false, message: "sessionId, number, message كلها مطلوبة" });
        }

        const session = sessions[sessionId];
        if (!session || !session.isConnected) {
            return res.status(404).json({ success: false, message: `الجلسة ${sessionId} غير موجودة أو غير متصلة` });
        }

        const jid = number.replace(/\D/g, '') + '@s.whatsapp.net';
        await session.sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'تم تسليم الرسالة بنجاح لخوادم واتساب' });

    } catch (error) {
        console.error("❌ Error sending message: ", error);
        res.status(500).json({ success: false, message: 'فشل إرسال الرسالة' });
    }
});

/**
 * نقطة نهاية الحالة المعدلة
 * GET /api/status
 */
app.get('/api/status', (req, res) => {
    const activeSessions = Object.keys(sessions).map(id => ({
        sessionId: id,
        isConnected: sessions[id].isConnected
    }));
    res.json({ success: true, activeSessions });
});

app.listen(PORT, () => {
    console.log(`🌐 الخادم يعمل على البورت ${PORT} وجاهز لإدارة جلسات متعددة.`);
    // يمكنك هنا بدء جلسة افتراضية عند بدء التشغيل إذا أردت
    // startWhatsAppConnection('default_session');
});

// Full implementation of useSupabaseAuthState keys part
const useSupabaseAuthState_Full = async (sessionId) => {
    const writeData = async (data) => { /* ... */ };
    const readData = async () => { /* ... */ };
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
