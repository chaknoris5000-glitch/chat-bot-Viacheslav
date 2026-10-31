const express = require('express');
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');
const { AuthDataValidator } = require('@telegram-auth/server');
const { urlStrToAuthDataMap } = require('@telegram-auth/server/utils');
const ExcelJS = require('exceljs');

try { require('dotenv').config(); } catch (e) {}

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID || '';
// ЖЕСТКО ПРОПИСАННЫЕ ДАННЫЕ ДЛЯ ВЯЧЕСЛАВА
const CLIENT_ID = 'Viacheslav';
const BUSINESS_NAME = 'Авто-Сервис Белово';
const SITE_TO_CRAWL = 'https://forward42.ru/';
const BASE_URL = 'https://forward42.ru/';

const COMMON_SUPABASE_URL = process.env.COMMON_SUPABASE_URL || process.env.SUPABASE_URL || '';
const COMMON_SUPABASE_KEY = process.env.COMMON_SUPABASE_KEY || process.env.SUPABASE_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';
const FIRECRAWL_KEY = process.env.FIRECRAWL_KEY || '';
const PRICE_PER_LEAD = Number(process.env.PRICE_PER_LEAD) || 25;
const REPORT_HOUR = Number(process.env.REPORT_HOUR) || 20;
const AI_MODEL_CHAT = process.env.AI_MODEL_CHAT || 'deepseek/deepseek-chat';
const AI_MODEL_EMBED = process.env.AI_MODEL_EMBED || 'openai/text-embedding-3-small';
const AI_MODEL_VOICE = process.env.AI_MODEL_VOICE || 'openai/whisper-large-v3';

const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || '';
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';
const YOOKASSA_RETURN_URL = process.env.YOOKASSA_RETURN_URL || 'https://t.me/vadim602_bot';

const TARIFFS = {
  'start': { name: 'Старт', amountMonth: 1990, amountYear: 14900 },
  'business': { name: 'Бизнес', amountMonth: 2490, amountYear: 19900 },
  'unlimited': { name: 'Безлимит', amountMonth: 4990, amountYear: 39900 },
  'result': { name: 'За результат', amountMonth: 25, amountYear: 25 }
};

const processedUpdates = new Set();
const newClientStates = {};

// ========== КЛИЕНТЫ ==========
async function getClient(clientId) {
  try {
    const r = await fetch(`${COMMON_SUPABASE_URL}/rest/v1/clients?client_id=eq.${clientId}&select=*&limit=1`, {
      headers: { 'apikey': COMMON_SUPABASE_KEY, 'Authorization': `Bearer ${COMMON_SUPABASE_KEY}` }
    });
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) { return null; }
}

function isPaid(client) {
  if (!client || !client.paid_until) return false;
  return new Date(client.paid_until) > new Date();
}

async function extendPayment(clientId, months = 1) {
  const client = await getClient(clientId);
  if (!client) return null;
  const base = client.paid_until && new Date(client.paid_until) > new Date() ? new Date(client.paid_until) : new Date();
  base.setMonth(base.getMonth() + months);
  await fetch(`${COMMON_SUPABASE_URL}/rest/v1/clients?client_id=eq.${clientId}`, {
    method: 'PATCH', headers: { 'apikey': COMMON_SUPABASE_KEY, 'Authorization': `Bearer ${COMMON_SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ paid_until: base.toISOString(), updated_at: new Date().toISOString() })
  });
  return base;
  
}
async function createYookassaPayment(chatId, tariffKey, period = 'month') {
  const tariff = TARIFFS[tariffKey];
  if (!tariff) return null;

  const amount = period === 'year' ? tariff.amountYear : tariff.amountMonth;
  const desc = period === 'year' ? `Годовая подписка ${tariff.name}` : `Месячная подписка ${tariff.name}`;

  const idempotenceKey = `pay_${chatId}_${tariffKey}_${period}_${Date.now()}`;
  const auth = Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64');

  try {
    const r = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Idempotence-Key': idempotenceKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: { value: amount.toFixed(2), currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: YOOKASSA_RETURN_URL },
        description: `AI-Администратор: ${desc}`,
        receipt: {
          customer: { email: 'chaknoris5000@gmail.com' },
          items: [{
            description: `Подписка ${tariff.name}`,
            quantity: '1.00',
            amount: { value: amount.toFixed(2), currency: 'RUB' },
            vat_code: 1,
            payment_mode: 'full_payment',
            payment_subject: 'service'
          }]
        },
        metadata: { chat_id: chatId.toString(), tariff: tariffKey, period: period }
      })
    });
    
    const data = await r.json();
    if (r.ok && data.confirmation && data.confirmation.confirmation_url) {
      return data.confirmation.confirmation_url;
    }
    console.log('Ошибка ЮKassa:', data);
    return null;
  } catch (e) {
    console.log('Ошибка запроса к ЮKassa:', e.message);
    return null;
  }
}

// ========== БАЗА ==========
async function getEmbedding(text) {
  const r = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST', headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL_EMBED, input: text })
  });
  const data = await r.json();
  if (!r.ok) throw new Error('embedding error');
  return data.data[0].embedding;
}

async function searchDocuments(queryEmbedding, limit = 8) {
  try {
    const r = await fetch(`${COMMON_SUPABASE_URL}/rest/v1/documents?client_id=eq.${CLIENT_ID}&select=id,content,url,embedding`, {
      headers: { 'apikey': COMMON_SUPABASE_KEY, 'Authorization': `Bearer ${COMMON_SUPABASE_KEY}` }
    });
    if (!r.ok) return [];
    const docs = await r.json();
    if (!Array.isArray(docs) || docs.length === 0) return [];
    function parseEmb(str) { if (!str) return []; if (Array.isArray(str)) return str; return String(str).replace(/[\[\]]/g, '').split(',').map(Number); }
    function cos(a, b) { let dot = 0, na = 0, nb = 0; const len = Math.min(a.length, b.length); for (let i = 0; i < len; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return dot / (Math.sqrt(na) * Math.sqrt(nb)); }
    const scored = docs.map(doc => ({ id: doc.id, content: doc.content, similarity: cos(queryEmbedding, parseEmb(doc.embedding)) }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  } catch (e) { return []; }
}

async function saveDocument(content, embedding, url) {
  await fetch(`${COMMON_SUPABASE_URL}/rest/v1/documents`, {
    method: 'POST', headers: { 'apikey': COMMON_SUPABASE_KEY, 'Authorization': `Bearer ${COMMON_SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ content, embedding, url, client_id: CLIENT_ID })
  });
}

async function getOrCreateSession(sessionId) {
  try {
    const r = await fetch(`${COMMON_SUPABASE_URL}/rest/v1/chat_sessions?session_id=eq.${sessionId}&select=*`, {
      headers: { 'apikey': COMMON_SUPABASE_KEY, 'Authorization': `Bearer ${COMMON_SUPABASE_KEY}` }
    });
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length > 0) return rows[0];
    const ins = await fetch(`${COMMON_SUPABASE_URL}/rest/v1/chat_sessions`, {
      method: 'POST', headers: { 'apikey': COMMON_SUPABASE_KEY, 'Authorization': `Bearer ${COMMON_SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ session_id: sessionId, history: [], client_id: CLIENT_ID })
    });
    const created = await ins.json();
    if (Array.isArray(created) && created.length > 0) return created[0];
    return { session_id: sessionId, history: [], client_id: CLIENT_ID };
  } catch (e) { return { session_id: sessionId, history: [], client_id: CLIENT_ID }; }
}

async function getSessionByTelegram(chatId) {
  try {
    const r = await fetch(`${COMMON_SUPABASE_URL}/rest/v1/chat_sessions?telegram_chat_id=eq.${chatId}&client_id=eq.${CLIENT_ID}&select=*&order=updated_at.desc&limit=1`, {
      headers: { 'apikey': COMMON_SUPABASE_KEY, 'Authorization': `Bearer ${COMMON_SUPABASE_KEY}` }
    });
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch (e) { return null; }
}

async function updateSession(sessionId, patch) {
  try {
    await fetch(`${COMMON_SUPABASE_URL}/rest/v1/chat_sessions?session_id=eq.${sessionId}`, {
      method: 'PATCH', headers: { 'apikey': COMMON_SUPABASE_KEY, 'Authorization': `Bearer ${COMMON_SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
    });
  } catch (e) {}
}

async function saveLead(sessionId, name, phone, problem, source = 'site') {
  try {
    const r = await fetch(`${COMMON_SUPABASE_URL}/rest/v1/leads`, {
      method: 'POST', headers: { 'apikey': COMMON_SUPABASE_KEY, 'Authorization': `Bearer ${COMMON_SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ session_id: sessionId, client_id: CLIENT_ID, name: name || null, phone: phone || null, problem: problem || null, source, status: 'new' })
    });
    const inserted = await r.json();
    return Array.isArray(inserted) && inserted[0] ? inserted[0].id : 0;
  } catch (e) { return 0; }
}

// ========== TELEGRAM ==========
async function transcribeVoice(fileUrl) {
  try {
    const fileResp = await fetch(fileUrl);
    if (!fileResp.ok) return null;
    const buf = await fileResp.arrayBuffer();
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/ogg' }), 'voice.ogg');
    fd.append('model', AI_MODEL_VOICE);
    const r = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', { method: 'POST', headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}` }, body: fd });
    const d = await r.json();
    if (!r.ok) return null;
    return d.text || null;
  } catch (e) { return null; }
}

async function getTelegramFileUrl(fileId) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
  const d = await r.json();
  if (!d.ok) return null;
  return `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${d.result.file_path}`;
}

async function sendTelegram(chatId, text, keyboard = null) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function sendTelegramDoc(chatId, buffer, filename, caption = '') {
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('document', new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
  if (caption) formData.append('caption', caption);
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`, { method: 'POST', body: formData });
}

async function sendContact(chatId, phone, name) {
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('phone_number', phone);
  formData.append('first_name', name || 'Клиент');
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendContact`, { method: 'POST', body: formData });
}

async function answerCallback(callbackId, text = '') {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackId, text }) });
}

async function editMessage(chatId, messageId, text, keyboard = null) {
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function extractLeadData(text) {
  const data = { name: null, phone: null, problem: null, save: false };
  if (text.includes('[LEAD_SAVE]')) {
    data.save = true;
    const n = text.match(/\[NAME:([^\]]+)\]/); if (n) data.name = n[1].trim();
    const p = text.match(/\[PHONE:([^\]]+)\]/); if (p) data.phone = p[1].trim();
    const pr = text.match(/\[PROBLEM:([^\]]+)\]/); if (pr) data.problem = pr[1].trim();
  }
  return data;
}

function isValidLead(name, phone) {
  if (!name || !phone) return false;
  const bad = ['...', '..', '.', '-', '—', 'нет', 'не указано'];
  const n = String(name).trim().toLowerCase();
  const p = String(phone).trim().toLowerCase();
  return !bad.includes(n) && !bad.includes(p) && n.length >= 2 && p.replace(/\D/g, '').length >= 5;
}

function cleanReply(text) {
  return text.replace(/\[LEAD_SAVE\]/g, '').replace(/\[NAME:[^\]]*\]/g, '').replace(/\[PHONE:[^\]]*\]/g, '').replace(/\[PROBLEM:[^\]]*\]/g, '').replace(/\[SCROLL:[^\]]*\]/g, '').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/`/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

async function notifyManager(lead, leadId) {
  if (!MANAGER_CHAT_ID) return;
  const text = `🔥 <b>НОВАЯ ЗАЯВКА</b>\n\n👤 <b>Имя:</b> ${lead.name || '—'}\n📞 <b>Телефон:</b> ${lead.phone || '—'}\n💬 <b>Задача:</b> ${lead.problem || '—'}\n\n<i>Статус: 🆕 Новая</i>`;
  const keyboard = [[{ text: '🔄 Взять в работу', callback_data: `status_${leadId}_in_progress` }], [{ text: '📞 Позвонить', callback_data: `call_${leadId}` }, { text: '✉️ Написать', callback_data: `write_${leadId}` }]];
  try { await sendTelegram(MANAGER_CHAT_ID, text, keyboard); } catch (e) {}
}

async function askAI(message, history, sessionId) {
  let context = '';
  try {
    const emb = await getEmbedding(message);
    const matches = await searchDocuments(emb, 8);
    if (matches.length > 0) context = matches.map(m => m.content).join('\n\n---\n\n');
  } catch (e) {}

  const clientConfig = await getClient(CLIENT_ID);
  
  // ПРОМПТ БЕЗ ТВОИХ ЛИЧНЫХ ДАННЫХ (ТОЛЬКО ДЛЯ АВТОСЕРВИСА)
  const systemPrompt = clientConfig?.prompt || `Ты — AI-Администратор компании «${BUSINESS_NAME}». Ты опытный, живой менеджер по продажам. Твоя цель — проконсультировать клиента, собрать заявку и мягко работать с возражениями.
1. Общайся естественно, как живой человек.
2. Отвечай 2-4 предложения. Никаких длинных простыней.
3. Задавай ОДИН наводящий вопрос за раз.
4. Когда клиент назвал имя + телефон — добавь в САМОМ КОНЦЕ ответа:
[LEAD_SAVE][NAME:имя][PHONE:телефон][PROBLEM:краткая суть]

БАЗА ЗНАНИЙ:
${context || 'Информация временно недоступна.'}`;

  const messages = [{ role: 'system', content: systemPrompt }, ...(history || []).slice(-10), { role: 'user', content: message }];
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL_CHAT, messages, temperature: 0.6, max_tokens: 400 })
  });
  const data = await r.json();
  if (!r.ok) throw new Error('OpenRouter error');
  let reply = data.choices?.[0]?.message?.content || 'Нет ответа';

  const lowerMsg = message.toLowerCase();
  
  // ОСТАВЛЯЕМ ТОЛЬКО ПРОВЕРКУ НА ССЫЛКУ (ЧТОБЫ ОН НЕ ВЫДУМЫВАЛ АДРЕС)
  if (lowerMsg.includes('ссылка') || lowerMsg.includes('сайт') || lowerMsg.includes('адрес')) {
    reply = `Наш официальный сайт: ${BASE_URL}\n\nТам вы можете посмотреть наши услуги, цены и оставить заявку.`;
  }

  const leadData = extractLeadData(reply);
  if (leadData.save && isValidLead(leadData.name, leadData.phone)) {
    try {
      const leadId = await saveLead(sessionId, leadData.name, leadData.phone, leadData.problem);
      await notifyManager(leadData, leadId);
    } catch (e) {}
  }
  return cleanReply(reply);
}

// ========== ЭКСПОРТ ==========
async function buildXlsx(leads, title = 'Заявки') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title);
  ws.columns = [{ header: 'ID', key: 'id', width: 8 }, { header: 'Дата', key: 'date', width: 20 }, { header: 'Имя', key: 'name', width: 18 }, { header: 'Телефон', key: 'phone', width: 18 }, { header: 'Задача', key: 'problem', width: 45 }, { header: 'Статус', key: 'status', width: 14 }];
  leads.forEach(l => ws.addRow({ id: l.id, date: l.created_at ? new Date(l.created_at).toLocaleString('ru-RU') : '', name: l.name || '', phone: l.phone || '', problem: l.problem || '', status: l.status }));
  return await wb.xlsx.writeBuffer();
}

async function fetchLeads(sinceIso = null) {
  let url = `${COMMON_SUPABASE_URL}/rest/v1/leads?select=*&order=id.desc&client_id=eq.${CLIENT_ID}`;
  if (sinceIso) url += `&created_at=gte.${encodeURIComponent(sinceIso)}`;
  const r = await fetch(url, { headers: { 'apikey': COMMON_SUPABASE_KEY, 'Authorization': `Bearer ${COMMON_SUPABASE_KEY}` } });
  let leads = await r.json();
  if (!Array.isArray(leads)) leads = [];
  return leads.filter(l => isValidLead(l.name, l.phone));
}

function statsBlock(leads, periodLabel) {
  const total = leads.length;
  const closed = leads.filter(l => l.status === 'closed').length;
  const inProgress = leads.filter(l => l.status === 'in_progress').length;
  const sum = total * PRICE_PER_LEAD;
  return `📊 <b>${periodLabel}</b>\n\n📥 Всего заявок: <b>${total}</b>\n🔄 В работе: <b>${inProgress}</b>\n✅ Закрыто: <b>${closed}</b>\n💰 По тарифу «за результат»: <b>${sum} ₽</b>`;
}

// ========== ВЕБХУКИ ==========
app.get('/health', (req, res) => res.json({ ok: true, client_id: CLIENT_ID }));
app.get('/', (req, res) => res.json({ ok: true, service: 'AI-Администратор', client_id: CLIENT_ID }));

app.post('/message', async (req, res) => {
  try {
    const { message, session_id } = req.body;
    if (!message) return res.status(400).json({ error: 'Введите сообщение' });
    const client = await getClient(CLIENT_ID);
    if (!isPaid(client)) return res.json({ reply: 'Сервис временно приостановлен. Свяжитесь с менеджером.' });
    const sid = session_id || 'default';
    const session = await getOrCreateSession(sid);
    const reply = await askAI(message, session.history || [], sid);
    const newHistory = [...(session.history || []), { role: 'user', content: message }, { role: 'assistant', content: reply }];
    await updateSession(sid, { history: newHistory.slice(-20) });
    res.json({ reply, session_id: sid });
  } catch (error) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body.message;
    if (!msg) return;
    const chatId = msg.chat.id;
    let text = msg.text ? msg.text.trim() : '';

    if (msg.voice) {
      const fileUrl = await getTelegramFileUrl(msg.voice.file_id);
      const tr = await transcribeVoice(fileUrl);
      if (tr) text = tr.trim();
    }
    if (!text) return;

    const isManager = String(chatId) === String(MANAGER_CHAT_ID);

    if (text.startsWith('/start')) {
      const parts = text.split(' ');
      const payload = parts[1] || '';
      
      if (payload.startsWith('sess_')) {
        const sessId = payload;
        await getOrCreateSession(sessId);
        await updateSession(sessId, { telegram_chat_id: chatId });
        const sessionData = await getOrCreateSession(sessId);
        const history = sessionData.history || [];
        
        if (history.length > 0) {
          const lastMessages = history.slice(-4).map(m => `${m.role === 'user' ? 'Клиент' : 'Бот'}: ${m.content}`).join('\n');
          const prompt = `Клиент перешел с сайта в Telegram. Вот последние сообщения из их диалога:\n${lastMessages}\n\nНапиши ОДНО короткое (1-2 предложения) приветствие, которое логично продолжит этот диалог. Опирайся на то, что клиент хотел. НЕ пиши варианты ответов, НЕ пиши списки.`;
          try {
             const aiResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
               method: 'POST', headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
               body: JSON.stringify({ model: AI_MODEL_CHAT, messages: [{ role: 'user', content: prompt }], max_tokens: 150 })
             });
             const aiData = await aiResp.json();
             const aiGreeting = aiData.choices?.[0]?.message?.content || '👋 Продолжаем диалог с сайта. Чем помочь?';
             await sendTelegram(chatId, cleanReply(aiGreeting));
          } catch (e) { await sendTelegram(chatId, '👋 Продолжаем диалог с сайта. Чем помочь?'); }
        } else {
          await sendTelegram(chatId, '👋 Привет! Чем могу помочь?');
        }
        return;
      }

      const startKeyboard = [[{ text: '💳 Посмотреть тарифы', callback_data: 'menu_bill' }], [{ text: '🌐 Открыть сайт', url: BASE_URL }]];
      if (CLIENT_ID === 'tilda') {
        await sendTelegram(chatId, `Здравствуйте! 👋\n\nЯ AI-Администратор — отвечаю клиентам 24/7, собираю заявки и помогаю с ними работать.`, startKeyboard);
      } else {
        await sendTelegram(chatId, `Здравствуйте! 👋\n\nЯ AI-Администратор компании «${BUSINESS_NAME}». Отвечаю на вопросы, помогаю с записью и собираю заявки.`, [[{ text: '🌐 Перейти на сайт', url: BASE_URL }]]);
      }
      return;
    }

    if (isManager && text === '/leads') {
      const leads = (await fetchLeads()).slice(0, 10);
      const lines = leads.map((l, i) => `🆕 <b>${i+1}. ${l.name || '—'}</b> | ${l.phone || '—'}\n💬 ${l.problem || '—'}`);
      await sendTelegram(chatId, '📋 <b>Последние заявки</b>\n\n' + (lines.length ? lines.join('\n\n') : 'Заявок нет.'));
      return;
    }

    if (isManager && text === '/export') {
      const leads = await fetchLeads();
      if (!leads.length) { await sendTelegram(chatId, 'Заявок нет.'); return; }
      const buffer = await buildXlsx(leads, 'Все заявки');
      await sendTelegramDoc(chatId, buffer, `leads_${new Date().toISOString().slice(0,10)}.xlsx`, `📊 Выгрузка (${leads.length} шт.)`);
      return;
    }

    if (isManager && text === '/stats') {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const leads = await fetchLeads(today.toISOString());
      await sendTelegram(chatId, statsBlock(leads, `Итоги за сегодня (${today.toLocaleDateString('ru-RU')})`));
      return;
    }

    let chatSession = await getSessionByTelegram(chatId);
    if (!chatSession) {
      const newSid = 'tg_' + chatId + '_' + CLIENT_ID;
      await getOrCreateSession(newSid);
      await updateSession(newSid, { telegram_chat_id: chatId });
      chatSession = await getSessionByTelegram(chatId);
    }
    if (!chatSession) chatSession = { session_id: 'tg_' + chatId, history: [] };

    if (!isManager) {
      const client = await getClient(CLIENT_ID);
      if (!isPaid(client)) { await sendTelegram(chatId, '⛔️ Сервис временно приостановлен.'); return; }
    }

    const reply = await askAI(text, chatSession.history || [], chatSession.session_id);
    const newHistory = [...(chatSession.history || []), { role: 'user', content: text }, { role: 'assistant', content: reply }];
    await updateSession(chatSession.session_id, { history: newHistory.slice(-20) });
    await sendTelegram(chatId, reply);
  } catch (error) { console.log('Telegram error:', error); }
});

app.get('/crawl', async (req, res) => {
  try {
    const scrape = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST', headers: { 'Authorization': `Bearer ${FIRECRAWL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: SITE_TO_CRAWL, formats: ['markdown'], onlyMainContent: false })
    });
    const scrapeData = await scrape.json();
    if (!scrape.ok) return res.status(500).json({ error: 'Firecrawl error' });
    const text = scrapeData.data?.markdown || '';
    const chunks = [];
    for (let i = 0; i < text.length; i += 1000) chunks.push(text.slice(i, i + 1000));
    let saved = 0;
    for (const chunk of chunks) {
      try { const embedding = await getEmbedding(chunk); await saveDocument(chunk, embedding, SITE_TO_CRAWL); saved++; } catch (e) {}
    }
    res.json({ ok: true, saved, total: chunks.length });
  } catch (error) { res.status(500).json({ error: 'Ошибка кроулинга' }); }
});

// ========== CRON ==========
cron.schedule('0 7 * * 1', async () => {
  if (!MANAGER_CHAT_ID) return;
  const since = new Date(); since.setDate(since.getDate() - 7); since.setHours(0, 0, 0, 0);
  const leads = await fetchLeads(since.toISOString());
  if (!leads.length) return;
  await sendTelegram(MANAGER_CHAT_ID, statsBlock(leads, `Итоги за неделю`));
});

cron.schedule('0 7 1 * *', async () => {
  if (!MANAGER_CHAT_ID) return;
  const now = new Date(); const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0);
  const leads = await fetchLeads(prevMonthStart.toISOString());
  if (!leads.length) return;
  await sendTelegram(MANAGER_CHAT_ID, statsBlock(leads, `Итоги за месяц`));
});

// ========== CRM И APP ==========
app.get('/crm', (req, res) => res.sendFile(path.join(__dirname, 'crm.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'app.html')));
app.get('/api/get-leads', async (req, res) => {
  const { client_id } = req.query;
  const url = `${COMMON_SUPABASE_URL}/rest/v1/leads?select=*&order=id.desc${client_id ? `&client_id=eq.${client_id}` : ''}`;
  const r = await fetch(url, { headers: { 'apikey': COMMON_SUPABASE_KEY, 'Authorization': `Bearer ${COMMON_SUPABASE_KEY}` } });
  res.json(await r.json());
});
app.get('/api/get-client-by-owner', async (req, res) => {
  const { owner_telegram_id } = req.query;
  const url = `${COMMON_SUPABASE_URL}/rest/v1/clients?select=*&owner_telegram_id=eq.${owner_telegram_id}`;
  const r = await fetch(url, { headers: { 'apikey': COMMON_SUPABASE_KEY, 'Authorization': `Bearer ${COMMON_SUPABASE_KEY}` } });
  res.json(await r.json());
});

// --- СОЗДАНИЕ КЛИЕНТА ИЗ CRM ---
app.post('/api/create-client', async (req, res) => {
  try {
    const { client_id, business_name, site_url, timezone, manager_chat_id, bot_token, owner_telegram_id } = req.body;
    
    const ghRes = await fetch(`https://api.github.com/repos/chaknoris5000-glitch/chat-bot-tilda/actions/workflows/create-client.yml/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${process.env.MY_GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: { client_id, business_name, site_url, timezone, manager_chat_id, bot_token, owner_telegram_id }
      })
    });

    if (!ghRes.ok) {
      const errText = await ghRes.text();
      throw new Error(`GitHub API: ${errText}`);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка создания клиента:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- ПОДДЕРЖКА ---
app.post('/api/support', async (req, res) => {
  try {
    const { message, user_id, name } = req.body;
    if (!message) return res.status(400).json({ ok: false });

    if (MANAGER_CHAT_ID) {
      await sendTelegram(MANAGER_CHAT_ID, `🆘 <b>Обращение в поддержку</b>\n\nОт: ${name} (ID: ${user_id})\n\nСообщение:\n${message}`);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---
// --- ОПЛАТА ---
app.post('/api/create-payment', async (req, res) => {
  try {
    const { chat_id, tariff, period } = req.body;
    const payUrl = await createYookassaPayment(chat_id, tariff, period);
    if (payUrl) {
      res.json({ ok: true, url: payUrl });
    } else {
      res.status(500).json({ ok: false, error: 'Ошибка ЮKassa' });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/connect-result', async (req, res) => {
  try {
    const { chat_id, name, manager_id } = req.body;
    if (manager_id) {
      await sendTelegram(manager_id, `🔥 <b>Новое подключение!</b>\n\nКлиент: ${name} (ID: ${chat_id})\nТариф: За результат (25 ₽/заявка)\n\n<i>Оплата будет формироваться по факту заявок.</i>`);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- АВТОРИЗАЦИЯ TELEGRAM ---
app.all('/auth/telegram', async (req, res) => {
  try {
    const params = req.method === 'GET' ? req.query : req.body;
    const { hash, ...data } = params;
    
    if (!hash) throw new Error('Нет параметра hash');

    const dataCheckString = Object.keys(data)
      .sort()
      .map(key => `${key}=${data[key]}`)
      .join('\n');

    const crypto = require('crypto');
    const secretKey = crypto.createHash('sha256').update(TELEGRAM_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash !== hash) {
      throw new Error('Неверная подпись');
    }

    res.json({ ok: true, telegram_id: data.id, first_name: data.first_name });
    
  } catch (e) {
    console.error('Ошибка авторизации Telegram:', e.message);
    res.status(401).json({ ok: false, error: 'Неверная подпись' });
  }
});

// --- ЗАПУСК СЕРВЕРА ---
app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
