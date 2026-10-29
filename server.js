const express = require('express');
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');
// Добавляем библиотеку для проверки Telegram
const { AuthDataValidator } = require('@telegram-auth/server');
const { urlStrToAuthDataMap } = require('@telegram-auth/server/utils');

try { require('dotenv').config(); } catch (e) {}

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';
const FIRECRAWL_KEY = process.env.FIRECRAWL_KEY || '';
const SITE_TO_CRAWL = 'https://g-energy.org/service/ru';
const BUSINESS_NAME = 'Авто-Сервис Белово';
const CLIENT_ID = 'Viacheslav';
const PRICE_PER_LEAD = Number(process.env.PRICE_PER_LEAD) || 25;
const BASE_URL = 'https://g-energy.org/service/ru';
const REPORT_HOUR = Number(process.env.REPORT_HOUR) || 20;
const AI_MODEL_CHAT = process.env.AI_MODEL_CHAT || 'deepseek/deepseek-chat';
const AI_MODEL_EMBED = process.env.AI_MODEL_EMBED || 'openai/text-embedding-3-small';
const AI_MODEL_VOICE = process.env.AI_MODEL_VOICE || 'openai/whisper-large-v3';

const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || '';
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';
const YOOKASSA_RETURN_URL = process.env.YOOKASSA_RETURN_URL || 'https://t.me/vadim602_bot';

const TARIFFS = {
  'start': { 
    name: 'Старт', 
    amountMonth: Number(process.env.TARIFF_START_MONTH) || 1990, 
    amountYear: Number(process.env.TARIFF_START_YEAR) || 14900 
  },
  'business': { 
    name: 'Бизнес', 
    amountMonth: Number(process.env.TARIFF_BUSINESS_MONTH) || 2490, 
    amountYear: Number(process.env.TARIFF_BUSINESS_YEAR) || 19900 
  },
  'unlimited': { 
    name: 'Безлимит', 
    amountMonth: Number(process.env.TARIFF_UNLIMITED_MONTH) || 4990, 
    amountYear: Number(process.env.TARIFF_UNLIMITED_YEAR) || 39900 
  },
  'result': { 
    name: 'За результат', 
    amountMonth: 25, 
    amountYear: 25 
  }
};

const processedUpdates = new Set();
const newClientStates = {}; // Память для пошагового создания

// ========== КЛИЕНТЫ И ОПЛАТА ==========

async function getClient(clientId) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/clients?client_id=eq.${clientId}&select=*&limit=1`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
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
  const base = client.paid_until && new Date(client.paid_until) > new Date()
    ? new Date(client.paid_until)
    : new Date();
  base.setMonth(base.getMonth() + months);
  await fetch(`${SUPABASE_URL}/rest/v1/clients?client_id=eq.${clientId}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ paid_until: base.toISOString(), updated_at: new Date().toISOString() })
  });
  return base;
}

async function disablePayment(clientId) {
  await fetch(`${SUPABASE_URL}/rest/v1/clients?client_id=eq.${clientId}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ paid_until: new Date(Date.now() - 86400000).toISOString(), updated_at: new Date().toISOString() })
  });
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

// ========== БАЗОВЫЕ ФУНКЦИИ ==========

async function getEmbedding(text) {
  const r = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL_EMBED, input: text })
  });
  const data = await r.json();
  if (!r.ok) throw new Error('embedding error');
  return data.data[0].embedding;
}

async function transcribeVoice(fileUrl) {
  try {
    const fileResp = await fetch(fileUrl);
    if (!fileResp.ok) return null;
    const buf = await fileResp.arrayBuffer();
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/ogg' }), 'voice.ogg');
    fd.append('model', AI_MODEL_VOICE);
    const r = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}` },
      body: fd
    });
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

async function searchDocuments(queryEmbedding, limit = 8) {
  try {
    // ИСПРАВЛЕНО: Сначала фильтр client_id, потом select
    const r = await fetch(`${SUPABASE_URL}/rest/v1/documents?client_id=eq.${CLIENT_ID}&select=id,content,url,embedding`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if (!r.ok) { console.log('Supabase fetch error'); return []; }
    const docs = await r.json();
    if (!Array.isArray(docs) || docs.length === 0) { console.log('docs empty'); return []; }

        function parseEmb(str) {
      if (!str) return [];
      if (Array.isArray(str)) return str;
      return String(str).replace(/[\[\]]/g, '').split(',').map(Number);
    }
    function cos(a, b) {
      let dot = 0, na = 0, nb = 0;
      const len = Math.min(a.length, b.length);
      for (let i = 0; i < len; i++) {
        dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
      }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    const scored = docs.map(doc => ({
      id: doc.id,
      content: doc.content,
      similarity: cos(queryEmbedding, parseEmb(doc.embedding))
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  } catch (e) {
    console.log('search error:', e.message);
    return [];
  }
}

async function saveDocument(content, embedding, url) {
  await fetch(`${SUPABASE_URL}/rest/v1/documents`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ content, embedding, url, client_id: CLIENT_ID })
  });
}

async function getOrCreateSession(sessionId) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/chat_sessions?session_id=eq.${sessionId}&select=*`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length > 0) return rows[0];
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/chat_sessions`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      // ИСПРАВЛЕНО: добавлен client_id
      body: JSON.stringify({ session_id: sessionId, history: [], client_id: CLIENT_ID })
    });
    const created = await ins.json();
    if (Array.isArray(created) && created.length > 0) return created[0];
    return { session_id: sessionId, history: [], client_id: CLIENT_ID };
  } catch (e) { return { session_id: sessionId, history: [], client_id: CLIENT_ID }; }
}

async function getSessionByTelegram(chatId) {
  try {
    // ИСПРАВЛЕНО: добавлен фильтр client_id
    const r = await fetch(`${SUPABASE_URL}/rest/v1/chat_sessions?telegram_chat_id=eq.${chatId}&client_id=eq.${CLIENT_ID}&select=*&order=updated_at.desc&limit=1`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch (e) { return null; }
}

async function updateSession(sessionId, patch) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/chat_sessions?session_id=eq.${sessionId}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
    });
  } catch (e) {}
}

async function saveLead(sessionId, name, phone, problem, source = 'site') {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ session_id: sessionId, client_id: CLIENT_ID, name: name || null, phone: phone || null, problem: problem || null, source, status: 'new' })
    });
    const inserted = await r.json();
    const leadId = Array.isArray(inserted) && inserted[0] ? inserted[0].id : 0;
    console.log('💾 saveLead status:', r.status, '| id:', leadId, '| name:', name, '| phone:', phone);
    return leadId;
  } catch (e) {
    console.log('❌ saveLead error:', e.message);
    return 0;
  }
}

// ========== TELEGRAM API ==========

async function sendTelegram(chatId, text, keyboard = null) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
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
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text })
  });
}

async function editMessage(chatId, messageId, text, keyboard = null) {
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

// ========== ЛОГИКА ЗАЯВОК ==========

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
  if (bad.includes(n) || bad.includes(p)) return false;
  if (n.length < 2) return false;
  if (p.replace(/\D/g, '').length < 5) return false;
  return true;
}

function cleanReply(text) {
  return text
    .replace(/\[LEAD_SAVE\]/g, '').replace(/\[NAME:[^\]]*\]/g, '').replace(/\[PHONE:[^\]]*\]/g, '').replace(/\[PROBLEM:[^\]]*\]/g, '')
    .replace(/\[SCROLL:[^\]]*\]/g, '') 
    .replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').replace(/__(.*?)__/g, '$1').replace(/_(.*?)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/`/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

async function notifyManager(lead, leadId) {
  if (!MANAGER_CHAT_ID) return;
  const text = `🔥 <b>НОВАЯ ЗАЯВКА</b>\n\n` +
    `👤 <b>Имя:</b> ${lead.name || '—'}\n` +
    `📞 <b>Телефон:</b> ${lead.phone || '—'}\n` +
    `💬 <b>Задача:</b> ${lead.problem || '—'}\n\n` +
    `<i>Статус: 🆕 Новая</i>`;

  const keyboard = [
    [{ text: '🔄 Взять в работу', callback_data: `status_${leadId}_in_progress` }],
    [
      { text: '📞 Позвонить', callback_data: `call_${leadId}` },
      { text: '✉️ Написать', callback_data: `write_${leadId}` }
    ]
  ];

  try {
    await sendTelegram(MANAGER_CHAT_ID, text, keyboard);
    console.log('✅ Уведомление отправлено менеджеру:', lead.phone);
  } catch (e) {
    console.log('❌ notifyManager error:', e.message);
  }
}

// ========== ИИ ==========

async function askAI(message, history, sessionId) {
  let context = '';
  try {
    const emb = await getEmbedding(message);
    const matches = await searchDocuments(emb, 8);
    if (matches.length > 0) {
      context = matches.map(m => m.content).join('\n\n---\n\n');
    }
  } catch (e) { console.log('Контекст не собран:', e.message); }
const clientConfig = await getClient(CLIENT_ID);
      const systemPrompt = clientConfig?.prompt || `Ты — AI-Администратор компании «${BUSINESS_NAME}». Ты опытный, живой менеджер по продажам, который общается с клиентами на сайте и в Telegram. Твоя цель — продать услугу, собрать заявку и мягко работать с возражениями.
1. Ты — живой человек, а не робот. Общайся максимально естественно, как в обычном чате. Используй слова вроде «Отлично», «Понял», «Да, это решаемо».
2. Отвечай ОЧЕНЬ коротко: строго 1-3 предложения. Никаких длинных текстов и простыней.
3. НЕ используй списки, тире, нумерацию, звёздочки. Только обычный текст.
4. Не повторяй вопрос клиента. Не используй шаблонные фразы.
5. Задавай ОДИН наводящий вопрос за раз, чтобы поддерживать диалог.
6. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО повторять один и тот же оффер (про "2 дня", "бесплатную неделю" и т.д.) в каждом сообщении. Предлагай подключиться только тогда, когда клиент сам проявит интерес (например, спросит про цену или как начать). Не дави на него.
7. НИКОГДА не пиши маркеры [LEAD_SAVE] в обычных сообщениях.

УМНАЯ НАВИГАЦИЯ ПО САЙТУ:
Если клиент спрашивает про цены/тарифы — в ответе ОБЯЗАТЕЛЬНО добавь тег [SCROLL:tariffs]. 
Если клиент спрашивает "как это работает" — добавь [SCROLL:how].
Если клиент просит показать примеры/демо — добавь [SCROLL:demos].
Если клиент спрашивает про гарантии — добавь [SCROLL:guarantee].
Если спрашивает "почему вы" или "почему я" — добавь [SCROLL:why-me].
Если спрашивает "кому подходит" или про сферы бизнеса — добавь [SCROLL:for-whom].
Если просит оферту или договор — добавь [SCROLL:oferta].
Если просит отзывы — добавь [SCROLL:reviews].

ТВОИ ЗНАНИЯ О ПРОДУКТЕ:
- Бот работает 24/7, отвечает мгновенно.
- Понимает голосовые сообщения.
- Собирает заявки (имя, телефон, запрос).
- Работает как CRM: все заявки в одном месте, группировка, выгрузка в Excel и на почту.
- Публичная оферта: ИП Груданов Вячеслав Владимирович, работает официально.
- Первая неделя и настройка ВСЕГДА бесплатно.
- Отключить можно в любой момент (без штрафов).

ТВОИ ЮРИДИЧЕСКИЕ ДАННЫЕ (ЗАПОМНИ НАИЗУСТЬ):
- Мы работаем официально.
- Наш юридический адрес: Кемеровская обл., гор. Белово, ул. 1-я Боевая 42-10.
- ИП Груданов Вячеслав Владимирович.
- Если клиент спрашивает адрес или ИНН — отвечай строго этими данными, ничего не выдумывай.

ТАРИФЫ И ЦЕНЫ (ЗНАЙ ИХ НАИЗУСТЬ):
1. Тариф «Старт» — ${TARIFFS.start.amountMonth} ₽/мес (до 100 заявок, свыше — ${PRICE_PER_LEAD} ₽/заявка). При годовой оплате — ${TARIFFS.start.amountYear} ₽/год.
2. Тариф «Бизнес» — ${TARIFFS.business.amountMonth} ₽/мес (до 300 заявок, свыше — ${PRICE_PER_LEAD} ₽/заявка). При годовой оплате — ${TARIFFS.business.amountYear} ₽/год.
3. Тариф «Безлимит» — ${TARIFFS.unlimited.amountMonth} ₽/мес (без ограничений). При годовой оплате — ${TARIFFS.unlimited.amountYear} ₽/год.
4. Тариф «За результат» — ${PRICE_PER_LEAD} ₽ за заявку (платит в конце месяца).

ПРАВИЛА ПРОДАЖ (ВОРОНКА):
1. Поздоровайся и спроси, чем занимается бизнес.
2. Уточни боль: теряются ли заявки?
3. Покажи выгоду.
4. Если спрашивают цену — озвучь ВСЕ 4 ТАРИФА кратко.
5. Обязательно подчеркни: "Настройка и первая неделя бесплатно" (но только если уместно!).
6. Призыв к действию: «Оставьте имя и телефон» (сделай это один раз, не навязчиво).

СБОР ЗАЯВКИ:
Когда клиент назвал имя + телефон — добавь в САМОМ КОНЦЕ ответа:
[LEAD_SAVE][NAME:имя][PHONE:телефон][PROBLEM:краткая суть]

КОНТЕКСТ ДИАЛОГА:
Если ты видишь, что диалог начался на сайте (в истории есть предыдущие сообщения), не начинай разговор с нуля. Продолжай его по смыслу. Например: "Возвращаясь к вашему вопросу про тарифы..." или "Как я понял, вас интересует...".

БАЗА ЗНАНИЙ:
${context || 'Информация временно недоступна.'}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(history || []).slice(-10),
    { role: 'user', content: message }
  ];

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL_CHAT, messages, temperature: 0.6, max_tokens: 400 })
  });
  const data = await r.json();
  if (!r.ok) throw new Error('OpenRouter error');
  let reply = data.choices?.[0]?.message?.content || 'Нет ответа';

  const lowerMsg = message.toLowerCase();
  
  if (lowerMsg.includes('тариф') || lowerMsg.includes('цен') || lowerMsg.includes('стоимост') || lowerMsg.includes('подробн')) {
    if (!reply.includes('[SCROLL:')) reply += ' [SCROLL:tariffs]';
    if (!reply.includes(BASE_URL)) reply += `\n\nПосмотреть тарифы: ${BASE_URL}/?go=tariffs`;
  }
  
  if (lowerMsg.includes('как работает') || lowerMsg.includes('как это работает')) {
    if (!reply.includes('[SCROLL:')) reply += ' [SCROLL:how]';
    if (!reply.includes(BASE_URL)) reply += `\n\nКак это работает: ${BASE_URL}/?go=how`;
  }
  
  if (lowerMsg.includes('пример') || lowerMsg.includes('демо')) {
    if (!reply.includes('[SCROLL:')) reply += ' [SCROLL:demos]';
    if (!reply.includes(BASE_URL)) reply += `\n\nПримеры работ: ${BASE_URL}/?go=demos`;
  }

  if (lowerMsg.includes('гаранти')) {
    if (!reply.includes('[SCROLL:')) reply += ' [SCROLL:guarantee]';
    if (!reply.includes(BASE_URL)) reply += `\n\nО гарантиях: ${BASE_URL}/?go=guarantee`;
  }

  if (lowerMsg.includes('почему вы') || lowerMsg.includes('почему я') || lowerMsg.includes('кому доверять')) {
    if (!reply.includes('[SCROLL:')) reply += ' [SCROLL:why-me]';
    if (!reply.includes(BASE_URL)) reply += `\n\nПочему стоит выбрать нас: ${BASE_URL}/?go=why-me`;
  }

  if (lowerMsg.includes('выгод')) {
    if (!reply.includes('[SCROLL:')) reply += ' [SCROLL:benefits]';
    if (!reply.includes(BASE_URL)) reply += `\n\nВыгоды: ${BASE_URL}/?go=benefits`;
  }

  if (lowerMsg.includes('прибыл') || lowerMsg.includes('заработ')) {
    if (!reply.includes('[SCROLL:')) reply += ' [SCROLL:profit]';
    if (!reply.includes(BASE_URL)) reply += `\n\nО прибыли: ${BASE_URL}/?go=profit`;
  }

  if (lowerMsg.includes('кому подход') || lowerMsg.includes('какой бизнес') || lowerMsg.includes('сферы')) {
    if (!reply.includes('[SCROLL:')) reply += ' [SCROLL:for-whom]';
    if (!reply.includes(BASE_URL)) reply += `\n\nКому подходит: ${BASE_URL}/?go=for-whom`;
  }

  if (lowerMsg.includes('оферт') || lowerMsg.includes('договор')) {
    if (!reply.includes('[SCROLL:')) reply += ' [SCROLL:oferta]';
    if (!reply.includes(BASE_URL)) reply += `\n\nПубличная оферта: ${BASE_URL}/?go=oferta`;
  }

  if (lowerMsg.includes('отзыв')) {
    if (!reply.includes('[SCROLL:')) reply += ' [SCROLL:reviews]';
    if (!reply.includes(BASE_URL)) reply += `\n\nОтзывы клиентов: ${BASE_URL}/?go=reviews`;
  }

  const leadData = extractLeadData(reply);
  if (leadData.save && isValidLead(leadData.name, leadData.phone)) {
    try {
      const leadId = await saveLead(sessionId, leadData.name, leadData.phone, leadData.problem);
      await notifyManager(leadData, leadId);
    } catch (e) { console.log('lead save/notify error:', e.message); }
  }

  return cleanReply(reply);
}

// ========== ЭКСПОРТ XLSX ==========

async function buildXlsx(leads, title = 'Заявки') {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title);

  ws.columns = [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Дата', key: 'date', width: 20 },
    { header: 'Имя', key: 'name', width: 18 },
    { header: 'Телефон', key: 'phone', width: 18 },
    { header: 'Задача', key: 'problem', width: 45 },
    { header: 'Источник', key: 'source', width: 12 },
    { header: 'Статус', key: 'status', width: 14 }
  ];

  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5B43' } };
  ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(1).height = 24;

  leads.forEach(l => {
    ws.addRow({
      id: l.id,
      date: l.created_at ? new Date(l.created_at).toLocaleString('ru-RU') : '',
      name: l.name || '',
      phone: l.phone || '',
      problem: l.problem || '',
      source: l.source === 'telegram' ? 'Telegram' : 'Сайт',
      status: l.status === 'closed' ? 'Закрыта' : (l.status === 'in_progress' ? 'В работе' : 'Новая')
    });
  });

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFDDDDDD' } },
        left: { style: 'thin', color: { argb: 'FFDDDDDD' } },
        bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } },
        right: { style: 'thin', color: { argb: 'FFDDDDDD' } }
      };
      cell.alignment = { vertical: 'top', wrapText: true };
      if (rowNumber > 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowNumber % 2 === 0 ? 'FFF7F9F8' : 'FFFFFFFF' } };
      }
    });
  });

  return await wb.xlsx.writeBuffer();
}

async function fetchLeads(sinceIso = null) {
  let url = `${SUPABASE_URL}/rest/v1/leads?select=*&order=id.desc&client_id=eq.${CLIENT_ID}`;
  if (sinceIso) url += `&created_at=gte.${encodeURIComponent(sinceIso)}`;
  const r = await fetch(url, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  let leads = await r.json();
  if (!Array.isArray(leads)) leads = [];
  return leads.filter(l => isValidLead(l.name, l.phone));
}

function statsBlock(leads, periodLabel) {
  const total = leads.length;
  const closed = leads.filter(l => l.status === 'closed').length;
  const inProgress = leads.filter(l => l.status === 'in_progress').length;
  const newOnes = total - closed - inProgress;
  const conversion = total > 0 ? Math.round((closed / total) * 100) : 0;
  const sum = total * PRICE_PER_LEAD;

  return `📊 <b>${periodLabel}</b>\n\n` +
    `📥 Всего заявок: <b>${total}</b>\n` +
    `🆕 Новых: <b>${newOnes}</b>\n` +
    `🔄 В работе: <b>${inProgress}</b>\n` +
    `✅ Закрыто: <b>${closed}</b>\n` +
    `📈 Конверсия: <b>${conversion}%</b>\n\n` +
    `💰 По тарифу «за результат»: <b>${total} × ${PRICE_PER_LEAD} ₽ = ${sum} ₽</b>`;
}

// ========== HEALTH ==========

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), uptime: process.uptime(), client_id: CLIENT_ID });
});

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'AI-Администратор Tilda', client_id: CLIENT_ID, time: new Date().toISOString() });
});

// ========== ВЕБХУКИ ==========

app.post('/yookassa-webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const event = req.body;
    
    if (event.event === 'payment.succeeded') {
      const payment = event.object;
      const chatId = payment.metadata.chat_id;
      const tariffKey = payment.metadata.tariff;
      const period = payment.metadata.period || 'month';

      if (chatId && tariffKey) {
        const monthsToAdd = period === 'year' ? 12 : 1;
        await extendPayment(chatId.toString(), monthsToAdd); 
        
        const tariffName = TARIFFS[tariffKey]?.name || 'AI-Администратор';
        const periodLabel = period === 'year' ? '1 год' : '1 месяц';

        await sendTelegram(chatId, 
          `✅ <b>Оплата прошла успешно!</b>\n\n` +
          `Сумма: ${payment.amount.value} ₽\n` +
          `Ваша подписка на тариф «${tariffName}» активирована на ${periodLabel}.\n\n` +
          `Спасибо за доверие!`
        );
        
        if (MANAGER_CHAT_ID) {
          await sendTelegram(MANAGER_CHAT_ID, 
            `💰 <b>Новая оплата!</b>\n` +
            `Клиент: ${chatId}\n` +
            `Тариф: ${tariffName}\n` +
            `Период: ${periodLabel}\n` +
            `Сумма: ${payment.amount.value} ₽`
          );
        }
      }
    }
  } catch (e) {
    console.log('Ошибка вебхука ЮKassa:', e.message);
  }
});

app.post('/message', async (req, res) => {
  try {
    const { message, session_id } = req.body;
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Введите сообщение' });

    const client = await getClient(CLIENT_ID);
    if (!isPaid(client)) {
      return res.json({ reply: 'Сервис временно приостановлен. Свяжитесь с менеджером.', session_id: session_id || 'default' });
    }

    const sid = session_id || 'default';
    const session = await getOrCreateSession(sid);
    const history = session.history || [];
    const reply = await askAI(message, history, sid);
    const newHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }];
    await updateSession(sid, { history: newHistory.slice(-20) });
    res.json({ reply, session_id: sid });
  } catch (error) {
    console.log('Server error:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const updateId = req.body.update_id;
    if (updateId) {
      if (processedUpdates.has(updateId)) {
        console.log('♻️ Дубль пропущен:', updateId);
        return;
      }
      processedUpdates.add(updateId);
      if (processedUpdates.size > 500) {
        const arr = Array.from(processedUpdates);
        processedUpdates.clear();
        arr.slice(-200).forEach(id => processedUpdates.add(id));
      }
    }

    if (req.body.callback_query) {
      const cb = req.body.callback_query;
      const chatId = cb.message.chat.id;
      const messageId = cb.message.message_id;
      const data = cb.data;

      if (String(chatId) !== String(MANAGER_CHAT_ID)) { await answerCallback(cb.id, 'Нет доступа'); return; }

      if (data === 'menu_bill') {
        const billText = `<b>Наши тарифы:</b>\n\n` +
          `1. <b>Старт</b> — ${TARIFFS.start.amountMonth} ₽/мес (до 100 заявок, далее ${PRICE_PER_LEAD} ₽/заявка).\n` +
          `2. <b>Бизнес</b> — ${TARIFFS.business.amountMonth} ₽/мес (до 300 заявок, далее ${PRICE_PER_LEAD} ₽/заявка).\n` +
          `3. <b>Безлимит</b> — ${TARIFFS.unlimited.amountMonth} ₽/мес (без ограничений).\n` +
          `4. <b>За результат</b> — ${PRICE_PER_LEAD} ₽ за заявку.\n\n` +
          `<i>При оплате за год скидка! Первая неделя бесплатно.</i>`;
        
        await answerCallback(cb.id, 'Загружаю тарифы...');
        await sendTelegram(chatId, billText);
        await sendTelegram(chatId, `Подробнее на сайте: ${BASE_URL}/?go=tariffs`);
        return;
      }

      if (data.startsWith('status_')) {
        const parts = data.split('_');
        const leadId = parts[1];
        const newStatus = parts.slice(2).join('_');

        await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${leadId}`, {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: newStatus, updated_at: new Date().toISOString() })
        });

        const statusLabel = newStatus === 'closed' ? '✅ Закрыта' : (newStatus === 'in_progress' ? '🔄 В работе' : '🆕 Новая');
        await answerCallback(cb.id, `Статус: ${statusLabel}`);

        let newKeyboard = [];
        if (newStatus === 'in_progress') {
          newKeyboard = [
            [{ text: '✅ Закрыть', callback_data: `status_${leadId}_closed` }],
            [
              { text: '📞 Позвонить', callback_data: `call_${leadId}` },
              { text: '✉️ Написать', callback_data: `write_${leadId}` }
            ]
          ];
        } else if (newStatus === 'closed') {
          newKeyboard = [[{ text: '🔄 Вернуть в работу', callback_data: `status_${leadId}_in_progress` }]];
        } else {
          newKeyboard = [
            [{ text: '🔄 Взять в работу', callback_data: `status_${leadId}_in_progress` }],
            [
              { text: '📞 Позвонить', callback_data: `call_${leadId}` },
              { text: '✉️ Написать', callback_data: `write_${leadId}` }
            ]
          ];
        }

        const baseText = cb.message.text.replace(/\n\n<i>Статус:.*<\/i>$/, '');
        await editMessage(chatId, messageId, `${baseText}\n\n<i>Статус: ${statusLabel}</i>`, newKeyboard);
        return;
      }

      if (data.startsWith('call_')) {
        const leadId = data.split('_')[1];
        const r = await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${leadId}&select=*`, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        const rows = await r.json();
        if (!Array.isArray(rows) || !rows[0]) { await answerCallback(cb.id, 'Заявка не найдена'); return; }
        const l = rows[0];
        await answerCallback(cb.id, `Телефон: ${l.phone}`);
        await sendContact(chatId, l.phone, l.name);
        return;
      }

      if (data.startsWith('write_')) {
        const leadId = data.split('_')[1];
        const r = await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${leadId}&select=*`, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        const rows = await r.json();
        if (!Array.isArray(rows) || !rows[0]) { await answerCallback(cb.id, 'Заявка не найдена'); return; }
        const l = rows[0];
        const digits = (l.phone || '').replace(/\D/g, '');
        await answerCallback(cb.id, 'Ссылка ниже');
        await sendTelegram(chatId, `👤 ${l.name || '—'}\n📞 ${l.phone || '—'}\n💬 ${l.problem || '—'}\n\n🔗 https://t.me/+${digits}`);
        return;
      }

      return;
    }

    const msg = req.body.message;
    if (!msg) return;
    const chatId = msg.chat.id;
    let text = '';

    if (msg.voice) {
      const fileUrl = await getTelegramFileUrl(msg.voice.file_id);
      if (!fileUrl) return;
      const tr = await transcribeVoice(fileUrl);
      if (!tr) { await sendTelegram(chatId, 'Не удалось распознать. Напишите текстом.'); return; }
      text = tr.trim();
    } else if (msg.text) {
      text = msg.text.trim();
    } else return;

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
          const prompt = `Сгенерируй короткое (1-2 предложения) приветствие для клиента, который перешел с сайта в Telegram. Вот последние сообщения из их диалога:\n${lastMessages}\n\nНапиши приветствие, которое логично продолжит этот диалог. Не пиши шаблонное "Чем помочь", а сошлись на прошлую тему.`;
          
          try {
             const aiResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
               method: 'POST',
               headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
               body: JSON.stringify({ model: AI_MODEL_CHAT, messages: [{ role: 'user', content: prompt }], max_tokens: 100 })
             });
             const aiData = await aiResp.json();
             const aiGreeting = aiData.choices?.[0]?.message?.content || '👋 Продолжаем диалог с сайта. Чем помочь?';
             await sendTelegram(chatId, cleanReply(aiGreeting));
          } catch (e) {
             await sendTelegram(chatId, '👋 Продолжаем диалог с сайта. Чем помочь?');
          }
        } else {
          await sendTelegram(chatId, '👋 Привет! Продолжаем. Что вас интересует?');
        }
        return;
      }

      if (payload.startsWith('pay_')) {
        const payParts = payload.split('_');
        const tariffKey = payParts[1];
        const period = payParts[2] || 'month';
        
        if (TARIFFS[tariffKey]) {
          await sendTelegram(chatId, '⏳ Создаю ссылку на оплату...');
          const payUrl = await createYookassaPayment(chatId, tariffKey, period);
          
          if (payUrl) {
            const tariff = TARIFFS[tariffKey];
            const amount = period === 'year' ? tariff.amountYear : tariff.amountMonth;
            const periodLabel = period === 'year' ? 'год' : 'месяц';

            await sendTelegram(chatId, 
              `💳 <b>Счёт на оплату тарифа «${tariff.name}»</b>\n\n` +
              `Период: ${periodLabel}\n` +
              `Сумма: ${amount} ₽.\n\n` +
              `Перейдите по ссылке ниже, чтобы оплатить. После оплаты подписка активируется автоматически.`,
              [[{ text: '💸 Перейти к оплате', url: payUrl }]]
            );
          } else {
            await sendTelegram(chatId, '❌ Ошибка при создании счёта. Попробуйте позже.');
          }
          return;
        }
      }

      const startKeyboard = [
        [{ text: '💳 Посмотреть тарифы', callback_data: 'menu_bill' }],
        [{ text: '🌐 Открыть сайт', url: BASE_URL }]
      ];

      if (payload === 'free') {
        await sendTelegram(chatId, 
          `Отличное решение! 👌\n\n` +
          `Чтобы запустить тест на 7 дней, мне понадобится ваше имя и телефон. Напишите их сюда, и я передам данные менеджеру.\n\n` +
          `Если есть вопросы — задавайте, обсудим.`, 
          startKeyboard
        );
        return;
      }

      if (payload.startsWith('tariff_')) {
        const tariffKey = payload.split('_')[1];
        const tariffName = TARIFFS[tariffKey]?.name || 'выбранный';
        await sendTelegram(chatId, 
          `Отличный выбор! Тариф «${tariffName}» — это то, что нужно. 🚀\n\n` +
          `Давайте я покажу, как он будет работать именно на вашем бизнесе. Расскажите, чем вы занимаетесь?`, 
          startKeyboard
        );
        return;
      }

                  if (CLIENT_ID === 'tilda') {
        // Твоё личное, неизменное приветствие
        await sendTelegram(chatId, 
          `Здравствуйте! 👋\n\n` +
          `Я AI-Администратор — отвечаю клиентам 24/7, собираю заявки и помогаю с ними работать.\n\n` +
          `Можете посмотреть тарифы по кнопкам ниже, или просто расскажите, чем занимается ваш бизнес — я подскажу, как лучше настроить бота под ваши задачи.`, 
          [[{ text: '💳 Посмотреть тарифы', callback_data: 'menu_bill' }], [{ text: '🌐 Открыть сайт', url: BASE_URL }]]
        );
      } else {
        // Приветствие для клиентов (Лиза и все будущие)
        await sendTelegram(chatId, 
          `Здравствуйте! 👋\n\n` +
          `Я AI-Администратор компании «${BUSINESS_NAME}». Отвечаю на вопросы, помогаю с записью и собираю заявки.\n\n` +
          `Напишите, что вас интересует, или перейдите на наш сайт по кнопке ниже.`, 
          [[{ text: '🌐 Перейти на сайт', url: BASE_URL }]]
        );
      }
      return; //
    } //

    // --- ПОШАГОВОЕ СОЗДАНИЕ КЛИЕНТА ---
    if (isManager && text === '/newclient') {
      newClientStates[chatId] = { step: 'waiting_for_id' };
      await sendTelegram(chatId, 'Шаг 1 из 4. Напиши ID клиента (латиницей, без пробелов, например: salon1):');
      return;
    }

    if (isManager && newClientStates[chatId]) {
      const state = newClientStates[chatId];
      
      if (state.step === 'waiting_for_id') {
        state.client_id = text;
        state.step = 'waiting_for_name';
        await sendTelegram(chatId, `Шаг 2 из 4. Напиши название бизнеса (например: Салон Красоты):`);
        return;
      }

      if (state.step === 'waiting_for_name') {
        state.business_name = text;
        state.step = 'waiting_for_url';
        await sendTelegram(chatId, `Шаг 3 из 4. Напиши ссылку на сайт (например: https://salon.tilda.ws):`);
        return;
      }

      if (state.step === 'waiting_for_url') {
        state.site_url = text;
        state.step = 'waiting_for_tz';
        await sendTelegram(chatId, `Шаг 4 из 4. Напиши часовой пояс (например: Europe/Moscow):`);
        return;
      }

      if (state.step === 'waiting_for_tz') {
        const tz = text || 'Europe/Moscow';
        const cid = state.client_id;
        const bname = state.business_name;
        const site = state.site_url;
        
        delete newClientStates[chatId]; 
        
        await sendTelegram(chatId, `⏳ Отправляю запрос на GitHub...`);
        
        try {
          const res = await fetch(`https://api.github.com/repos/chaknoris5000-glitch/chat-bot-tilda/actions/workflows/create-client.yml/dispatches`, {
            method: 'POST',
            headers: { 'Authorization': `token ${process.env.MY_GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: 'main', inputs: { client_id: cid, business_name: bname, site_url: site, timezone: tz, manager_chat_id: chatId.toString() } })
          });
          if (res.ok) await sendTelegram(chatId, `🚀 Задача запущена на серверах GitHub! Проверь папку "Действия" (Actions).`);
          else await sendTelegram(chatId, `❌ Ошибка GitHub: ${await res.text()}`);
        } catch (e) { await sendTelegram(chatId, `❌ Ошибка связи: ${e.message}`); }
        return;
      }
    }

    // --- ОСТАЛЬНЫЕ КОМАНДЫ ---
    if (isManager && text === '/leads') {
      const leads = (await fetchLeads()).slice(0, 10);
      if (leads.length === 0) { await sendTelegram(chatId, 'Заявок пока нет.'); return; }
      const lines = leads.map((l, i) => {
        const s = l.status === 'closed' ? '✅' : (l.status === 'in_progress' ? '🔄' : '🆕');
        return `${s} <b>${i+1}. ${l.name || '—'}</b> | ${l.phone || '—'}\n💬 ${l.problem || '—'}`;
      });
      await sendTelegram(chatId, '📋 <b>Последние заявки</b>\n\n' + lines.join('\n\n'));
      return;
    }

    if (isManager && text === '/export') {
      const leads = await fetchLeads();
      if (leads.length === 0) { await sendTelegram(chatId, 'Заявок пока нет.'); return; }
      const buffer = await buildXlsx(leads, 'Все заявки');
      await sendTelegramDoc(chatId, buffer, `leads_${new Date().toISOString().slice(0,10)}.xlsx`, `📊 Выгрузка заявок (${leads.length} шт.)`);
      return;
    }

    if (isManager && text === '/stats') {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const leads = await fetchLeads(today.toISOString());
      await sendTelegram(chatId, statsBlock(leads, `Итоги за сегодня (${today.toLocaleDateString('ru-RU')})`));
      return;
    }

    if (isManager && text === '/invoice') {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const leads = await fetchLeads(monthStart.toISOString());
      const total = leads.length;
      const sum = total * PRICE_PER_LEAD;
      const monthLabel = now.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
      await sendTelegram(chatId, `🧾 <b>Счёт за ${monthLabel}</b>\n\n📥 Заявок: <b>${total}</b>\n💵 Цена: <b>${PRICE_PER_LEAD} ₽</b>\n💰 Итого: <b>${sum} ₽</b>`);
      return;
    }

    if (isManager && text === '/clients') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/clients?select=*&order=id.desc`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) { await sendTelegram(chatId, 'Клиентов нет.'); return; }
      const lines = rows.map(c => {
        const paid = isPaid(c);
        const until = c.paid_until ? new Date(c.paid_until).toLocaleDateString('ru-RU') : '—';
        const tz = c.timezone || 'Europe/Moscow';
        return `${paid ? '✅' : '⛔️'} <b>${c.client_id}</b> — ${c.business_name || '—'}\nОплачено до: ${until}\nЧасовой пояс: ${tz}`;
      });
      await sendTelegram(chatId, '👥 <b>Клиенты</b>\n\n' + lines.join('\n\n') + '\n\n<i>Команды:\n/add id | название | chat_id | пояс\n/view id\n/remove id\n/paid id месяцев\n/unpaid id</i>');
      return;
    }

    if (isManager && text.startsWith('/paid ')) {
      const parts = text.split(' ');
      const cid = parts[1];
      const months = parseInt(parts[2] || '1', 10);
      if (!cid || isNaN(months) || months < 1) {
        await sendTelegram(chatId, 'Формат: /paid client_id количество_месяцев\nПример: /paid tilda 1');
        return;
      }
      const newDate = await extendPayment(cid, months);
      if (!newDate) { await sendTelegram(chatId, `Клиент «${cid}» не найден.`); return; }
      await sendTelegram(chatId, `✅ Клиенту «${cid}» оплата продлена на ${months} мес.\nНовая дата: ${newDate.toLocaleDateString('ru-RU')}`);
      return;
    }

    if (isManager && text.startsWith('/unpaid ')) {
      const cid = text.split(' ')[1];
      if (!cid) { await sendTelegram(chatId, 'Формат: /unpaid client_id'); return; }
      await disablePayment(cid);
      await sendTelegram(chatId, `⛔️ Клиенту «${cid}» оплата отключена.`);
      return;
    }

    if (isManager && text.startsWith('/add ')) {
      const raw = text.slice(5).trim();
      const parts = raw.split('|').map(s => s.trim());
      if (parts.length < 3) {
        await sendTelegram(chatId, 'Формат:\n/add client_id | название | chat_id | часовой_пояс\n\nПример:\n/add salon-1 | Салон Красоты | 5818548555 | Europe/Moscow');
        return;
      }
      const [cid, bname, cchat, ctz] = [parts[0], parts[1], parts[2], parts[3] || 'Europe/Moscow'];

      const existing = await getClient(cid);
      if (existing) {
        await sendTelegram(chatId, `⚠️ Клиент «${cid}» уже существует.\nИспользуй /paid для продления или /remove для удаления.`);
        return;
      }

      const r = await fetch(`${SUPABASE_URL}/rest/v1/clients`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({
          client_id: cid,
          business_name: bname,
          chat_id: parseInt(cchat, 10) || null,
          paid_until: new Date(Date.now() + 7 * 86400000).toISOString(),
          timezone: ctz
        })
      });
      if (!r.ok) {
        const err = await r.text();
        await sendTelegram(chatId, `❌ Ошибка: ${err.slice(0, 200)}`);
        return;
      }
      await sendTelegram(chatId, `✅ Клиент «${cid}» добавлен.\n\n` +
        `Название: ${bname}\n` +
        `Chat ID: ${cchat}\n` +
        `Часовой пояс: ${ctz}\n` +
        `Оплачено до: ${new Date(Date.now() + 7 * 86400000).toLocaleDateString('ru-RU')} (+7 дней теста)`);
      return;
    }

    if (isManager && text.startsWith('/view ')) {
      const cid = text.slice(6).trim();
      const client = await getClient(cid);
      if (!client) { await sendTelegram(chatId, `Клиент «${cid}» не найден.`); return; }
      const paid = isPaid(client);
      const until = client.paid_until ? new Date(client.paid_until).toLocaleDateString('ru-RU') : '—';
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      const leadsMonth = await fetchLeads(monthStart.toISOString());
      const sum = leadsMonth.length * PRICE_PER_LEAD;

      await sendTelegram(chatId, `👤 <b>Клиент: ${client.client_id}</b>\n\n` +
        `🏢 Название: ${client.business_name || '—'}\n` +
        `💬 Chat ID: ${client.chat_id || '—'}\n` +
        `🌍 Часовой пояс: ${client.timezone || 'Europe/Moscow'}\n` +
        `💳 Статус: ${paid ? '✅ оплачено' : '⛔️ не оплачено'}\n` +
        `📅 Оплачено до: ${until}\n\n` +
        `📊 <b>За текущий месяц</b>\n` +
        `📥 Заявок: ${leadsMonth.length}\n` +
        `💰 По тарифу «за результат»: ${sum} ₽`);
      return;
    }

    if (isManager && text.startsWith('/remove ')) {
      const cid = text.slice(8).trim();
      const client = await getClient(cid);
      if (!client) { await sendTelegram(chatId, `Клиент «${cid}» не найден.`); return; }
      await fetch(`${SUPABASE_URL}/rest/v1/clients?client_id=eq.${cid}`, {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      await sendTelegram(chatId, `🗑 Клиент «${cid}» удалён.\n⚠️ Данные заявок не тронуты.`);
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
      if (!isPaid(client)) {
        await sendTelegram(chatId, '⛔️ Сервис временно приостановлен. Свяжитесь с менеджером.');
        return;
      }
    }

    const history = chatSession.history || [];
    const reply = await askAI(text, history, chatSession.session_id);
    const newHistory = [...history, { role: 'user', content: text }, { role: 'assistant', content: reply }];
    await updateSession(chatSession.session_id, { history: newHistory.slice(-20) });
    await sendTelegram(chatId, reply);
  } catch (error) {
    console.log('Telegram error:', error);
  }
});

app.get('/crawl', async (req, res) => {
  try {
    const scrape = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${FIRECRAWL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: SITE_TO_CRAWL, formats: ['markdown'] })
    });
    const scrapeData = await scrape.json();
    if (!scrape.ok) return res.status(500).json({ error: 'Firecrawl error' });
    const text = scrapeData.data?.markdown || '';
    const chunks = [];
    for (let i = 0; i < text.length; i += 1000) chunks.push(text.slice(i, i + 1000));

    let saved = 0;
    for (const chunk of chunks) {
      try {
        const embedding = await getEmbedding(chunk);
        await saveDocument(chunk, embedding, SITE_TO_CRAWL);
        saved++;
      } catch (e) {}
    }
    res.json({ ok: true, saved, total: chunks.length });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка кроулинга' });
  }
});

// ========== АВТОСВОДКИ С ЧАСОВЫМ ПОЯСОМ ==========

function getLocalTime(timezone) {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone || 'Europe/Moscow',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    const parts = fmt.formatToParts(now);
    const get = (t) => parts.find(p => p.type === t)?.value;
    return {
      hour: parseInt(get('hour'), 10),
      minute: parseInt(get('minute'), 10),
      dateStr: `${get('year')}-${get('month')}-${get('day')}`
    };
  } catch (e) {
    return { hour: 20, minute: 0, dateStr: '' };
  }
}

async function sendDailyReportForClient(client) {
  try {
    const tz = client.timezone || 'Europe/Moscow';
    const local = getLocalTime(tz);

    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);

    const leads = await fetchLeads(since.toISOString());
    if (leads.length === 0) return;

    const chatId = client.chat_id || MANAGER_CHAT_ID;
    if (!chatId) return;

    await sendTelegram(chatId, statsBlock(leads, `Итоги за сегодня (${local.dateStr})`));
    const buffer = await buildXlsx(leads, 'День');
    await sendTelegramDoc(chatId, buffer, `leads_day_${local.dateStr}.xlsx`, `📥 Заявки за день (${leads.length} шт.)`);
    console.log(`✅ Сводка отправлена клиенту ${client.client_id} (${tz})`);
  } catch (e) {
    console.log('sendDailyReportForClient error:', e.message);
  }
}

cron.schedule('*/15 * * * *', async () => {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/clients?select=*`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const clients = await r.json();
    if (!Array.isArray(clients)) return;

    for (const client of clients) {
      if (!isPaid(client)) continue;
      const tz = client.timezone || 'Europe/Moscow';
      const local = getLocalTime(tz);
      if (local.hour === REPORT_HOUR && local.minute >= 0 && local.minute < 15) {
        await sendDailyReportForClient(client);
      }
    }
  } catch (e) { console.log('cron 15min error:', e.message); }
});

cron.schedule('0 7 * * 1', async () => {
  try {
    if (!MANAGER_CHAT_ID) return;
    const since = new Date(); since.setDate(since.getDate() - 7); since.setHours(0, 0, 0, 0);
    const leads = await fetchLeads(since.toISOString());
    console.log('⏰ cron week сработал, заявок:', leads.length);
    if (leads.length === 0) return;
    await sendTelegram(MANAGER_CHAT_ID, statsBlock(leads, `Итоги за неделю (${since.toLocaleDateString('ru-RU')} — ${new Date().toLocaleDateString('ru-RU')})`));
    const buffer = await buildXlsx(leads, 'Неделя');
    await sendTelegramDoc(MANAGER_CHAT_ID, buffer, `leads_week_${new Date().toISOString().slice(0,10)}.xlsx`, `📥 Заявки за неделю (${leads.length} шт.)`);
  } catch (e) { console.log('cron week error:', e.message); }
});

cron.schedule('0 7 1 * *', async () => {
  try {
    if (!MANAGER_CHAT_ID) return;
    const now = new Date();
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0);
    const leads = await fetchLeads(prevMonthStart.toISOString());
    console.log('⏰ cron month сработал, заявок:', leads.length);
    if (leads.length === 0) return;

    const total = leads.length;
    const sum = total * PRICE_PER_LEAD;
    const monthLabel = prevMonthStart.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

    await sendTelegram(MANAGER_CHAT_ID, statsBlock(leads, `Итоги за ${monthLabel}`));
    await sendTelegram(MANAGER_CHAT_ID, `🧾 <b>Счёт за ${monthLabel}</b>\n\n📥 Заявок: <b>${total}</b>\n💵 Цена: <b>${PRICE_PER_LEAD} ₽</b>\n💰 Итого: <b>${sum} ₽</b>`);

    const buffer = await buildXlsx(leads, 'Месяц');
    await sendTelegramDoc(MANAGER_CHAT_ID, buffer, `leads_month_${prevMonthStart.toISOString().slice(0,7)}.xlsx`, `📥 Заявки за ${monthLabel} (${total} шт.)`);
  } catch (e) { console.log('cron month error:', e.message); }
});

// ========== НАПОМИНАНИЯ ОБ ОПЛАТЕ ==========
cron.schedule('0 10 * * *', async () => { 
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/clients?select=*`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const clients = await r.json();
    if (!Array.isArray(clients)) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const client of clients) {
      if (!client.paid_until) continue;

      const paidDate = new Date(client.paid_until);
      paidDate.setHours(0, 0, 0, 0);

      const diffTime = paidDate.getTime() - today.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays === 1) {
        const chatId = client.chat_id || MANAGER_CHAT_ID;
        if (chatId) {
          await sendTelegram(chatId, 
            `⚠️ <b>Напоминание об оплате</b>\n\n` +
            `У клиента «${client.business_name || client.client_id}» завтра заканчивается подписка.\n` +
            `Не забудьте продлить оплату, чтобы бот не перестал работать!`
          );
        }
      }
    }
  } catch (e) {
    console.log('Ошибка при проверке напоминаний:', e.message);
  }
});
app.get('/crm', (req, res) => {
  res.sendFile(path.join(__dirname, 'crm.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});
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

    // Возвращаем JSON, а не редирект
    res.json({ ok: true, telegram_id: data.id, first_name: data.first_name });
    
  } catch (e) {
    console.error('Ошибка авторизации Telegram:', e.message);
    res.status(401).json({ ok: false, error: 'Неверная подпись' });
  }
});
// ========== СОЗДАНИЕ КЛИЕНТА ИЗ CRM ==========
app.post('/api/create-client', async (req, res) => {
  try {
        const { client_id, business_name, site_url, timezone, manager_chat_id, bot_token, owner_telegram_id } = req.body;
    
    // Проверка, что запрос пришел от тебя (по ID)
    // (Для простоты мы доверяем запросу, так как страница CRM защищена входом)
    
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
app.post('/api/support', async (req, res) => {
  try {
    const { message, user_id, name } = req.body;
    if (!message) return res.status(400).json({ ok: false });

    // Отправляем сообщение тебе (Админу)
    if (MANAGER_CHAT_ID) {
      await sendTelegram(MANAGER_CHAT_ID, `🆘 <b>Обращение в поддержку</b>\n\nОт: ${name} (ID: ${user_id})\n\nСообщение:\n${message}`);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

 // 1. Создание платежа ЮKassa
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

// 2. Уведомление о подключении тарифа "За результат"
app.post('/api/connect-result', async (req, res) => {
  try {
    const { chat_id, name, manager_id } = req.body;
    
    // Отправляем уведомление Админу (менеджеру)
    if (manager_id) {
      await sendTelegram(manager_id, `🔥 <b>Новое подключение!</b>\n\nКлиент: ${name} (ID: ${chat_id})\nТариф: За результат (25 ₽/заявка)\n\n<i>Оплата будет формироваться по факту заявок.</i>`);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.get('/api/get-leads', async (req, res) => {
  try {
    const { client_id } = req.query;
    const url = `${process.env.COMMON_SUPABASE_URL}/rest/v1/leads?select=*&order=id.desc${client_id ? `&client_id=eq.${client_id}` : ''}`;
    
    const r = await fetch(url, {
      headers: {
        'apikey': process.env.COMMON_SUPABASE_KEY,
        'Authorization': `Bearer ${process.env.COMMON_SUPABASE_KEY}`
      }
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/get-client-by-owner', async (req, res) => {
  try {
    const { owner_telegram_id } = req.query;
    const url = `${process.env.COMMON_SUPABASE_URL}/rest/v1/clients?select=*&owner_telegram_id=eq.${owner_telegram_id}`;
    const r = await fetch(url, {
      headers: {
        'apikey': process.env.COMMON_SUPABASE_KEY,
        'Authorization': `Bearer ${process.env.COMMON_SUPABASE_KEY}`
      }
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}); //

app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
