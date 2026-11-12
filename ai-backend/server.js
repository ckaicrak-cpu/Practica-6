
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { OpenAI } = require('openai');

const app = express();

app.use(express.json());
app.use(cors());

// Configurar conexión con OpenRouter
const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Endpoint para recibir los mensajes
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        error: 'Debes escribir un mensaje válido.'
      });
    }

    // Recuperar historial de conversación
    const previousMessages = Array.isArray(history)
      ? history.filter(
          item =>
            item &&
            ['user', 'assistant'].includes(item.role) &&
            typeof item.content === 'string'
        ).slice(-20)
      : [];

    const messages = [
      ...previousMessages,
      { role: 'user', content: message.trim() }
    ];

    // Consultar el modelo de IA
    const completion =
      await openrouter.chat.completions.create({
        model: process.env.OPENROUTER_MODEL,
        messages: messages
      });

    // Recuperar respuesta
    const reply = completion.choices[0]?.message?.content;

    if (!reply) {
      return res.status(502).json({
        error: 'La IA no devolvió una respuesta.'
      });
    }

    // Enviar respuesta al frontend
    res.json({ reply });

  } catch (error) {
    console.error('Error de OpenRouter:', error);

    res.status(500).json({
      error: 'Error al procesar la solicitud con la IA.'
    });
  }
});

// Iniciar el servidor
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
