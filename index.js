const express = require('express');
const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { Boom } = require('@hapi/boom');
const P = require('pino');
require('dotenv').config();

// إعداد التطبيق
const app = express();
const PORT = process.env.PORT || 3000;

// إعداد middleware
app.use(express.json());

// إعداد logger خفيف
const logger = P({ level: 'silent' }); // صامت لتوفير الموارد

// متغيرات عامة لحالة الاتصال
let sock = null;
let isConnected = false;
let qrCodeGenerated = false;

/**
 * إنشاء اتصال واتساب مع إدارة الجلسة الخفيفة
 * نستخدم useMultiFileAuthState لحفظ بصمة المصادقة فقط
 */
async function startWhatsAppConnection() {
    try {
        // الحصول على أحدث إصدار من Baileys
        const { version } = await fetchLatestBaileysVersion();
        
        // إعداد حالة المصادقة - هنا يتم حفظ البصمة فقط
        // المجلد whatsapp_session سيحتوي على ملفات صغيرة جداً فقط:
        // - مفاتيح التشفير
        // - بيانات اعتماد الجهاز  
        // - معلومات التسجيل الأساسية
        const { state, saveCreds } = await useMultiFileAuthState('whatsapp_session');
        
        // إنشاء socket الاتصال مع إعدادات محسّنة للأداء
        sock = makeWASocket({
            version,
            logger, // استخدام logger صامت
            auth: state,
            printQRInTerminal: false, // نتحكم نحن في عرض QR
            defaultQueryTimeoutMs: 60000,
            // إعدادات لتوفير الموارد
            generateHighQualityLinkPreview: false,
            syncFullHistory: false, // لا نحفظ تاريخ الرسائل
            markOnlineOnConnect: false,
            // تحسينات إضافية
            shouldSyncHistoryMessage: () => false, // منع تزامن تاريخ الرسائل
            shouldIgnoreJid: () => false,
            getMessage: async () => undefined // منع حفظ الرسائل في الذاكرة
        });

        // معالج الاتصال - يتم حفظ بيانات المصادقة الخفيفة فقط
        sock.ev.on('creds.update', saveCreds);

        // معالج تحديثات الاتصال
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
                const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                
                console.log('❌ انقطع الاتصال:', lastDisconnect?.error);
                
                if (shouldReconnect) {
                    console.log('🔄 محاولة إعادة الاتصال...');
                    setTimeout(startWhatsAppConnection, 3000);
                } else {
                    console.log('🚪 تم تسجيل الخروج. يرجى إعادة تشغيل الخادم');
                }
            }
        });

        // معالج الرسائل - نتجاهل الرسائل الواردة لتوفير الموارد
        sock.ev.on('messages.upsert', () => {
            // لا نعالج الرسائل الواردة لتوفير الذاكرة والمعالجة
        });

    } catch (error) {
        console.error('❌ خطأ في بدء الاتصال:', error);
        // إعادة محاولة بعد 5 ثواني
        setTimeout(startWhatsAppConnection, 5000);
    }
}

/**
 * التحقق من صحة رقم الهاتف وتنسيقه
 */
function formatPhoneNumber(number) {
    // إزالة أي رموز غير رقمية
    let cleaned = number.replace(/\D/g, '');
    
    // التأكد من وجود رمز الدولة
    if (!cleaned.startsWith('966') && cleaned.length === 9) {
        cleaned = '966' + cleaned; // إضافة رمز السعودية افتراضياً
    }
    
    return cleaned + '@s.whatsapp.net';
}

/**
 * التحقق من وجود الرقم في واتساب
 */
async function checkNumberExists(jid) {
    try {
        const [result] = await sock.onWhatsApp(jid.replace('@s.whatsapp.net', ''));
        return result?.exists || false;
    } catch (error) {
        console.error('خطأ في التحقق من الرقم:', error);
        return false;
    }
}

// Routes - نقاط النهاية

/**
 * التحقق من حالة الاتصال
 * GET /api/status
 */
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        isReady: isConnected,
        message: isConnected ? 'الخدمة جاهزة' : 'في انتظار الاتصال'
    });
});

/**
 * إرسال رسالة
 * POST /api/send
 * Body: { "number": "966xxxxxxxx", "message": "نص الرسالة" }
 */
app.post('/api/send', async (req, res) => {
    try {
        const { number, message } = req.body;
        
        // التحقق من البيانات المطلوبة
        if (!number || !message) {
            return res.status(400).json({
                success: false,
                message: 'رقم الهاتف والرسالة مطلوبان'
            });
        }
        
        // التحقق من حالة الاتصال
        if (!isConnected || !sock) {
            return res.status(503).json({
                success: false,
                message: 'الخدمة غير متاحة. يرجى التأكد من الاتصال'
            });
        }
        
        // تنسيق رقم الهاتف
        const jid = formatPhoneNumber(number);
        
        // التحقق من وجود الرقم في واتساب
        const numberExists = await checkNumberExists(jid);
        if (!numberExists) {
            return res.status(404).json({
                success: false,
                message: 'رقم الهاتف غير موجود في واتساب'
            });
        }
        
        // إرسال الرسالة
        await sock.sendMessage(jid, { text: message });
        
        console.log(`✅ تم إرسال رسالة إلى: ${number}`);
        
        res.json({
            success: true,
            message: 'تم إرسال الرسالة بنجاح'
        });
        
    } catch (error) {
        console.error('❌ خطأ في إرسال الرسالة:', error);
        res.status(500).json({
            success: false,
            message: 'خطأ في إرسال الرسالة'
        });
    }
});

/**
 * معلومات أساسية عن الAPI
 * GET /
 */
app.get('/', (req, res) => {
    res.json({
        service: 'WhatsApp API',
        version: '1.0.0',
        endpoints: {
            status: 'GET /api/status',
            send: 'POST /api/send'
        },
        ready: isConnected
    });
});

// معالج الأخطاء العامة
app.use((error, req, res, next) => {
    console.error('❌ خطأ عام:', error);
    res.status(500).json({
        success: false,
        message: 'خطأ داخلي في الخادم'
    });
});

// معالج الصفحات غير الموجودة
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'المسار غير موجود'
    });
});

// بدء الخادم
async function startServer() {
    try {
        // بدء اتصال واتساب أولاً
        console.log('🚀 جاري بدء خدمة واتساب...');
        await startWhatsAppConnection();
        
        // بدء خادم Express
        app.listen(PORT, () => {
            console.log(`🌐 خادم API يعمل على البورت ${PORT}`);
            console.log(`📍 الحالة: http://localhost:${PORT}/api/status`);
            console.log(`📤 إرسال: POST http://localhost:${PORT}/api/send`);
            console.log('\n💡 ملاحظة: جلسة المصادقة محفوظة في مجلد whatsapp_session');
            console.log('📁 حجم الجلسة محسّن ليكون أقل ما يمكن (بضعة كيلوبايت فقط)');
        });
    } catch (error) {
        console.error('❌ فشل في بدء الخادم:', error);
        process.exit(1);
    }
}

// معالجة إيقاف الخادم بأمان
process.on('SIGINT', () => {
    console.log('\n🛑 جاري إيقاف الخادم...');
    if (sock) {
        sock.end();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 تم استلام إشارة الإيقاف...');
    if (sock) {
        sock.end();
    }
    process.exit(0);
});

// بدء التطبيق
startServer();