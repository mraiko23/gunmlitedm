# AI Chat API Server

Full-featured AI chat API with chat management, file attachments, and web interface.

## Features

- 🤖 Multiple AI models via g4f.dev
- 💬 Chat management (create, read, update, delete)
- 📎 File attachments support
- 🖼️ Image processing
- ⏱️ Rate limiting (5 requests/minute)
- 📱 Modern web interface
- 🗄️ SQLite database

## Deploy to Render

1. Push to GitHub
2. Create new Web Service on Render
3. Connect your repo
4. Set:
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Deploy!

## Local Development

```bash
npm install
npm start
```

Server runs on http://localhost:3000

## API Endpoints

### Chats
- `GET /api/chats` - List all chats
- `POST /api/chats` - Create new chat
- `GET /api/chats/:id` - Get chat with messages
- `PATCH /api/chats/:id` - Update chat title
- `DELETE /api/chats/:id` - Delete chat

### Messages
- `POST /api/chats/:chatId/messages` - Send message (with files)
- `DELETE /api/messages/:id` - Delete message

### Attachments
- `GET /api/attachments/:id` - Download attachment

### Models
- `GET /api/models` - List available models

## Environment Variables

- `PORT` - Server port (default: 3000)

## License

MIT
