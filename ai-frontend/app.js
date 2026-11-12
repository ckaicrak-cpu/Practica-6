
let conversationHistory = [];
let isSending = false;

const chatForm = document.getElementById('chatForm');
const inputField = document.getElementById('userInput');
const chatBox = document.getElementById('chatBox');
const sendButton = document.getElementById('sendButton');

// Escuchar cuando el usuario envía un mensaje
chatForm.addEventListener('submit', function (event) {
    event.preventDefault();
    sendMessage();
});

async function sendMessage() {
    const text = inputField.value.trim();

    if (!text || isSending) return;

    isSending = true;
    sendButton.disabled = true;

    // Mostrar mensaje del usuario
    appendMessage(text, 'user');

    inputField.value = '';

    try {
        // Enviar mensaje al backend
        const response = await fetch(
            'http://localhost:3000/api/chat',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: text,
                    history: conversationHistory
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.error || 'Error del servidor'
            );
        }

        if (!data.reply) {
            throw new Error('Respuesta vacía de la IA');
        }

        // Actualizar historial
        conversationHistory.push({
            role: 'user',
            content: text
        });

        conversationHistory.push({
            role: 'assistant',
            content: data.reply
        });

        // Mostrar respuesta
        appendMessage(data.reply, 'assistant');

    } catch (error) {
        console.error('Error:', error);

        appendMessage(
            'Error: ' + error.message,
            'assistant'
        );

    } finally {
        isSending = false;
        sendButton.disabled = false;
        inputField.focus();
    }
}

// Mostrar los mensajes en pantalla
function appendMessage(text, sender) {
    const messageDiv = document.createElement('div');

    messageDiv.className = `message ${sender}`;
    messageDiv.textContent = text;

    chatBox.appendChild(messageDiv);

    chatBox.scrollTop = chatBox.scrollHeight;
}
