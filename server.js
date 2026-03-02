import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============ REQUEST QUEUE SYSTEM ============
// Очередь запросов к AI API - обрабатываются по одному
const requestQueue = [];
let isProcessing = false;

function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  
  isProcessing = true;
  const { messages, model, images, resolve } = requestQueue.shift();
  
  executeAIRequest(messages, model, images)
    .then(result => {
      resolve(result);
      isProcessing = false;
      // Process next in queue
      setTimeout(processQueue, 100);
    })
    .catch(error => {
      // On error, put back at front and retry after 15s
      requestQueue.unshift({ messages, model, images, resolve });
      console.log('API error, retrying in 15s...', error.message);
      setTimeout(() => {
        isProcessing = false;
        processQueue();
      }, 15000);
    });
}

async function executeAIRequest(messages, model, images) {
  const formattedMessages = messages.map(m => ({
    role: m.role,
    content: m.content
  }));

  // Try g4f client first
  if (g4fClient) {
    try {
      const result = await g4fClient.chat.completions.create({
        model: model,
        messages: formattedMessages,
        images: images.length > 0 ? images : undefined
      });
      if (result?.choices?.[0]?.message?.content) {
        return result.choices[0].message.content;
      }
    } catch (e) {
      console.log('g4f client failed, trying API');
    }
  }

  // Try g4f.dev API with retry on rate limit
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await fetch('https://api.g4f.dev/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          messages: formattedMessages
        })
      });

      if (response.status === 429) {
        // Rate limited - wait and retry
        console.log(`Rate limited, waiting 15s (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, 15000));
        continue;
      }

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      if (data?.choices?.[0]?.message?.content) {
        return data.choices[0].message.content;
      }
      throw new Error('Invalid response format');
    } catch (e) {
      lastError = e;
      console.log(`API attempt ${attempt + 1} failed:`, e.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  throw lastError || new Error('All API attempts failed');
}

// Queue-based AI query - never rejects, always retries
function queryAIQueued(messages, model = 'glm-4', images = []) {
  return new Promise((resolve) => {
    requestQueue.push({ messages, model, images, resolve });
    processQueue();
  });
}

// JSON Database
const DB_FILE = './data/db.json';
let db = { chats: {}, messages: {}, attachments: {} };

async function loadDB() {
  try {
    const data = await fs.readFile(DB_FILE, 'utf-8');
    db = JSON.parse(data);
  } catch {
    db = { chats: {}, messages: {}, attachments: {} };
  }
}

async function saveDB() {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

async function initDB() {
  await fs.mkdir('./data', { recursive: true });
  await loadDB();
}

// File upload config
const storage = multer.memoryStorage();
const upload = multer({ 
  storage, 
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

// g4f client
let g4fClient = null;

async function initG4F() {
  try {
    const { createClient } = await import('g4f');
    g4fClient = createClient();
    console.log('g4f client initialized');
  } catch (e) {
    console.log('g4f not installed, using fetch directly');
  }
}

// Legacy function for backward compatibility
async function queryAI(messages, model = 'glm-4', images = []) {
  return queryAIQueued(messages, model, images);
}

// ============ CHAT ENDPOINTS ============

// List all chats
app.get('/api/chats', (req, res) => {
  const chats = Object.values(db.chats)
    .map(c => ({
      ...c,
      message_count: Object.values(db.messages).filter(m => m.chat_id === c.id).length
    }))
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  res.json(chats);
});

// Get single chat with messages
app.get('/api/chats/:id', (req, res) => {
  const chat = db.chats[req.params.id];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  
  const messages = Object.values(db.messages)
    .filter(m => m.chat_id === req.params.id)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  
  res.json({ ...chat, messages });
});

// Create new chat
app.post('/api/chats', async (req, res) => {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.chats[id] = {
    id,
    title: req.body.title || 'New Chat',
    created_at: now,
    updated_at: now
  };
  await saveDB();
  res.status(201).json(db.chats[id]);
});

// Update chat title
app.patch('/api/chats/:id', async (req, res) => {
  const chat = db.chats[req.params.id];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  
  chat.title = req.body.title;
  chat.updated_at = new Date().toISOString();
  await saveDB();
  res.json(chat);
});

// Delete chat
app.delete('/api/chats/:id', async (req, res) => {
  // Delete messages and attachments
  for (const msg of Object.values(db.messages)) {
    if (msg.chat_id === req.params.id) {
      for (const attId of msg.attachments || []) {
        delete db.attachments[attId];
      }
      delete db.messages[msg.id];
    }
  }
  delete db.chats[req.params.id];
  await saveDB();
  res.json({ success: true });
});

// ============ MESSAGE ENDPOINTS ============

// Send message and get AI response
app.post('/api/chats/:chatId/messages', upload.array('files', 5), async (req, res) => {
  const { content, model = 'glm-4' } = req.body;
  const files = req.files || [];
  
  try {
    // Save user message
    const userMsgId = uuidv4();
    const now = new Date().toISOString();
    db.messages[userMsgId] = {
      id: userMsgId,
      chat_id: req.params.chatId,
      role: 'user',
      content,
      model,
      attachments: [],
      created_at: now
    };
    
    // Process and save attachments
    const imageBase64s = [];
    for (const file of files) {
      const attId = uuidv4();
      let fileData = file.buffer.toString('base64');
      let mimetype = file.mimetype;
      
      // Compress images
      if (file.mimetype.startsWith('image/')) {
        const compressed = await sharp(file.buffer)
          .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        fileData = compressed.toString('base64');
        mimetype = 'image/jpeg';
        imageBase64s.push(`data:image/jpeg;base64,${fileData}`);
      }
      
      db.attachments[attId] = {
        id: attId,
        message_id: userMsgId,
        filename: file.originalname,
        mimetype,
        size: fileData.length,
        data: fileData,
        created_at: now
      };
      db.messages[userMsgId].attachments.push(attId);
    }
    
    // Get chat history
    const history = Object.values(db.messages)
      .filter(m => m.chat_id === req.params.chatId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(m => ({ role: m.role, content: m.content }));
    
    // Query AI (queued - will retry automatically on rate limit)
    const aiResponse = await queryAI(history, model, imageBase64s);
    
    // Save AI response
    const aiMsgId = uuidv4();
    db.messages[aiMsgId] = {
      id: aiMsgId,
      chat_id: req.params.chatId,
      role: 'assistant',
      content: aiResponse,
      model,
      attachments: [],
      created_at: new Date().toISOString()
    };
    
    // Update chat timestamp
    if (db.chats[req.params.chatId]) {
      db.chats[req.params.chatId].updated_at = new Date().toISOString();
    }
    
    // Auto-title from first message
    const firstMsg = Object.values(db.messages)
      .filter(m => m.chat_id === req.params.chatId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
    if (firstMsg && firstMsg.content && db.chats[req.params.chatId]) {
      const title = firstMsg.content.substring(0, 50) + (firstMsg.content.length > 50 ? '...' : '');
      db.chats[req.params.chatId].title = title;
    }
    
    await saveDB();
    
    res.json({
      userMessage: { id: userMsgId, role: 'user', content },
      assistantMessage: { id: aiMsgId, role: 'assistant', content: aiResponse }
    });
    
  } catch (error) {
    console.error('Message error:', error);
    // Never send error to user - return fallback message
    const fallbackResponse = 'Извините, произошла задержка. Попробуйте отправить сообщение ещё раз.';
    res.json({
      userMessage: { id: uuidv4(), role: 'user', content: req.body.content },
      assistantMessage: { id: uuidv4(), role: 'assistant', content: fallbackResponse }
    });
  }
});

// Get message attachments
app.get('/api/messages/:messageId/attachments', (req, res) => {
  const msg = db.messages[req.params.messageId];
  if (!msg) return res.json([]);
  
  const attachments = (msg.attachments || [])
    .map(id => {
      const a = db.attachments[id];
      if (!a) return null;
      const { data, ...rest } = a;
      return rest;
    })
    .filter(Boolean);
  res.json(attachments);
});

// Get attachment file
app.get('/api/attachments/:id', (req, res) => {
  const att = db.attachments[req.params.id];
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  
  res.setHeader('Content-Type', att.mimetype);
  res.setHeader('Content-Disposition', `inline; filename="${att.filename}"`);
  const buffer = Buffer.from(att.data, 'base64');
  res.send(buffer);
});

// Delete message
app.delete('/api/messages/:id', async (req, res) => {
  const msg = db.messages[req.params.id];
  if (msg) {
    for (const attId of msg.attachments || []) {
      delete db.attachments[attId];
    }
    delete db.messages[req.params.id];
    await saveDB();
  }
  res.json({ success: true });
});

// ============ MODELS ENDPOINT ============

app.get('/api/models', (req, res) => {
  res.json([
    { id: 'glm-4', name: 'GLM-4', description: 'Fast and capable' },
    { id: 'glm-5', name: 'GLM-5', description: 'Latest GLM model' },
    { id: 'llama-3.1-70b', name: 'Llama 3.1 70B', description: 'Large Llama model' },
    { id: 'mixtral-8x7b', name: 'Mixtral 8x7B', description: 'Mixture of experts' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'OpenAI mini model' },
    { id: 'claude-3-haiku', name: 'Claude 3 Haiku', description: 'Fast Claude' },
    { id: 'gemini-pro', name: 'Gemini Pro', description: 'Google Gemini' }
  ]);
});

// ============ STREAMING ENDPOINT ============

app.post('/api/chats/:chatId/stream', async (req, res) => {
  const { content, model = 'glm-4' } = req.body;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  try {
    // Save user message
    const userMsgId = uuidv4();
    const now = new Date().toISOString();
    db.messages[userMsgId] = {
      id: userMsgId,
      chat_id: req.params.chatId,
      role: 'user',
      content,
      model,
      attachments: [],
      created_at: now
    };
    
    // Get history
    const history = Object.values(db.messages)
      .filter(m => m.chat_id === req.params.chatId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(m => ({ role: m.role, content: m.content }));
    
    // For now, simulate streaming (g4f doesn't support true streaming)
    const fullResponse = await queryAI(history, model);
    
    // Stream response word by word
    const words = fullResponse.split(' ');
    for (let i = 0; i < words.length; i++) {
      res.write(`data: ${JSON.stringify({ word: words[i] + (i < words.length - 1 ? ' ' : ''), done: false })}\n\n`);
      await new Promise(r => setTimeout(r, 30));
    }
    
    // Save AI response
    const aiMsgId = uuidv4();
    db.messages[aiMsgId] = {
      id: aiMsgId,
      chat_id: req.params.chatId,
      role: 'assistant',
      content: fullResponse,
      model,
      attachments: [],
      created_at: new Date().toISOString()
    };
    
    if (db.chats[req.params.chatId]) {
      db.chats[req.params.chatId].updated_at = new Date().toISOString();
    }
    
    await saveDB();
    
    res.write(`data: ${JSON.stringify({ done: true, messageId: aiMsgId })}\n\n`);
    res.end();
    
  } catch (error) {
    console.error('Stream error:', error);
    // Send fallback message instead of error
    res.write(`data: ${JSON.stringify({ word: 'Произошла ошибка. Попробуйте ещё раз.', done: true })}\n\n`);
    res.end();
  }
});

// ============ STATIC FILES ============

app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ START SERVER ============

async function start() {
  await initDB();
  await initG4F();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`API: http://localhost:${PORT}/api`);
  });
}

start();
