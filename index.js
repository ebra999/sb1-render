const express = require('express');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    useMultiFileAuthState, // We will use this as a base
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

if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase URL and Key are required!');
}

const supabase = createClient(supabaseUrl, supabaseKey);
const logger = P({ level: 'silent' });

// --- نظام مخصص لإدارة الجلسة مع Supabase ---
const useSupabaseAuthState = async (sessionId) => {
    const writeData = async (data, id) => {
        const dataString = JSON.stringify(data, BufferJSON.replacer);
        // Use the session ID as the primary key
        const { error } = await supabase
            .from('whatsapp_sessions')
            .upsert({ id: id, session_data: { [id]: dataString } }, { onConflict: 'id' });
        
        if (error) {
            console.error('Error writing session data to Supabase:', id, error);
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
        
        if (data && data.session_data && data.session_data[id]) {
            return JSON.parse(data.session_data[id], BufferJSON.reviver);
        }
        return null;
    };

    const removeData = async (id) => {
        const { error } = await supabase
            .from('whatsapp_sessions')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('Error removing session data from Supabase:', error);
        }
    };

    const creds = await readData('creds') || {
        noiseKey: Buffer.alloc(32),
        signedIdentityKey: Buffer.alloc(32),
        signedPreKey: { keyId: 0, keyPair: { private: Buffer.alloc(32), public: Buffer.alloc(32) }, signature: Buffer.alloc(64) },
        registrationId: 0,
        advSecretKey: '',
        processedHistoryMessages: [],
        nextPreKeyId: 1,
        firstUnuploadedPreKeyId: 1,
        accountSettings: { unarchiveChats: false },
    };

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const key in data[category]) {
                            const value = data[category][key];
                            const id = `${category}-${key}`;
                            await writeData(value, id);
                        }
                    }
                },
            },
        },
        saveCreds: async () => {
            await writeData('creds', creds);
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
        const { state, saveCreds } = await useSupabaseAuthState('main-session');
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
                console.log('\n📱 امسح رمز QR التالي بواتساب (هذه هي المرة الأخيرة!):');
                qrcode.generate(qr, { small: true });
            }
            
            if (connection === 'open') {
                console.log('✅ تم الاتصال بواتساب بنجاح والجلسة الآن محفوظة.');
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

// --- بقية الكود (نقاط النهاية) بدون تغيير ---
app.get('/api/status', (req, res) => {
    res.json({ success: true, isReady: isConnected, message: isConnected ? 'الخدمة جاهزة' : 'في انتظار الاتصال' });
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
    res.json({ service: "WhatsApp API with Supabase", version: "1.4.0-stable", ready: isConnected });
});
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
