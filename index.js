const express = require('express');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    useMultiFileAuthState, // الدالة الرسمية والموثوقة من المكتبة
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

// --- المحول الذي يربط بين Baileys و Supabase ---
// هذا الكود يعترض عمليات الملفات ويوجهها إلى قاعدة البيانات
const supabaseAuthStore = (sessionId) => {
    const prefix = `session-${sessionId}-`;
    
    return {
        writeToFile: async (path, data) => {
            const id = prefix + path;
            const { error } = await supabase.from('whatsapp_sessions').upsert({ id, session_data: data });
            if (error) console.error(`Error writing file "${path}" to Supabase:`, error);
        },
        readFromFile: async (path) => {
            const id = prefix + path;
            const { data, error } = await supabase.from('whatsapp_sessions').select('session_data').eq('id', id).single();
            if (error && error.code !== 'PGRST116') console.error(`Error reading file "${path}" from Supabase:`, error);
            return data ? data.session_data : null;
        },
        removeFile: async (path) => {
            const id = prefix + path;
            const { error } = await supabase.from('whatsapp_sessions').delete().eq('id', id);
            if (error) console.error(`Error removing file "${path}" from Supabase:`, error);
        },
        folderExists: async () => {
            const { data } = await supabase.from('whatsapp_sessions').select('id').eq('id', `${prefix}creds.json`).single();
            return !!data;
        }
    };
};

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());

let sock = null;
let isConnected = false;

async function startWhatsAppConnection() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(
            'main', // مجرد معرف للجلسة
            supabaseAuthStore('main') // استخدام المحول المخصص
        );
        
        const { version } = await fetchLatestBaileysVersion();
        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: state,
        });

        // هذا الربط الآن يعمل بشكل صحيح، حيث أن "saveCreds" ستستخدم المحول
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) qrcode.generate(qr, { small: true });
            if (connection === 'open') isConnected = true;
            if (connection === 'close') {
                isConnected = false;
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) startWhatsAppConnection();
            }
        });

    } catch (error) {
        console.error('❌ خطأ فادح في بدء الاتصال:', error);
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
app.get('/', (req, res) => res.json({ service: "WhatsApp API", version: "4.0.0-final", ready: isConnected }));
function formatPhoneNumber(number) {
    let cleaned = number.replace(/\D/g, '');
    if (cleaned.length === 9 && !cleaned.startsWith('966')) { cleaned = '966' + cleaned; }
    return cleaned + '@s.whatsapp.net';
}
app.listen(PORT, () => {
    console.log(`🌐 الخادم يعمل على البورت ${PORT}`);
    startWhatsAppConnection();
});
