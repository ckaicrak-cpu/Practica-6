const express = require('express');
const cors = require('cors');
require('dotenv').config();

const mysql = require('mysql2/promise');
const { OpenAI } = require('openai');

const app = express();

app.use(express.json());
app.use(cors());

// Pool de conexiones a la base de datos Sakila en MySQL (Laragon)
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sakila',
  waitForConnections: true,
  connectionLimit: 10
});

// Configurar conexión con OpenRouter
const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY
});

const MAX_ROWS = 50;
const MAX_TOOL_ITERATIONS = 5;

const SYSTEM_PROMPT = `Eres un agente analista de datos experto conectado en tiempo real a la base de datos MySQL "sakila" (un sistema de alquiler de películas).

Esquema principal de sakila:
- film(film_id, title, description, release_year, language_id, original_language_id, rental_duration, rental_rate, length, replacement_cost, rating, special_features) — nota: length está en minutos (más de 2 horas = length > 120).
- category(category_id, name) y film_category(film_id, category_id) — ej. categoría 'Action'.
- actor(actor_id, first_name, last_name) y film_actor(actor_id, film_id).
- language(language_id, name).
- inventory(inventory_id, film_id, store_id).
- rental(rental_id, rental_date, inventory_id, customer_id, return_date, staff_id).
- payment(payment_id, customer_id, staff_id, rental_id, amount, payment_date).
- customer(customer_id, store_id, first_name, last_name, email, address_id, active, create_date).
- store(store_id, manager_staff_id, address_id) y staff(staff_id, first_name, last_name, address_id, email, store_id, active, username).
- address(address_id, address, address2, district, city_id, postal_code, phone), city(city_id, city, country_id), country(country_id, country).
- Vistas disponibles: film_list, nicer_but_slower_film_list, customer_list, staff_list, sales_by_store, sales_by_film_category, actor_info.

Reglas de operación:
1. Usa SIEMPRE la herramienta execute_sql para consultar datos reales de sakila antes de responder preguntas sobre películas, clientes, alquileres, ingresos o estadísticas. Nunca inventes datos.
2. Genera SQL válido para MySQL 8 (respeta ONLY_FULL_GROUP_BY incluyendo columnas no agregadas en GROUP BY o usando funciones de agregación).
3. Solo se permiten consultas de lectura (SELECT, SHOW, DESCRIBE, EXPLAIN, WITH).
4. MUY IMPORTANTE sobre fechas en sakila: los datos históricos de sakila son de 2005-2006. Para analizar inactividad de clientes, recencia o clientes que llevan mucho tiempo sin alquilar y podrían abandonar el servicio, NO uses NOW() ni CURDATE(). En su lugar, compara MAX(r.rental_date) de cada cliente respecto a la fecha más reciente registrada en toda la tabla rental: (SELECT MAX(rental_date) FROM rental), calculando días de inactividad con DATEDIFF((SELECT MAX(rental_date) FROM rental), MAX(r.rental_date)), ordenando SIEMPRE de mayor a menor inactividad (ORDER BY days_since_last_rental DESC) e incluyendo su cantidad de alquileres históricos (COUNT(r.rental_id)) y si están activos (c.active).
5. Para análisis de movimiento y recaudación promedio por día de la semana: cuando te pregunten por el movimiento o dinero promedio por día de la semana, SIEMPRE debes incluir en tu SELECT de SQL: el total de alquileres/pagos, el total recaudado (SUM(amount)), el promedio recaudado por cada fecha calendario de ese día de la semana (ROUND(SUM(amount) / COUNT(DISTINCT DATE(payment_date)), 2)) y el ticket promedio por pago (ROUND(AVG(amount), 2)), agrupando por DAYNAME(payment_date). Reporta todos estos valores claramente en tu respuesta.
6. Responde siempre en español, de forma clara, concisa y sustentada en los resultados exactos devueltos por SQL.`;

const tools = [
  {
    type: 'function',
    function: {
      name: 'execute_sql',
      description: 'Ejecuta una consulta SQL de solo lectura en la base de datos MySQL sakila y devuelve hasta 50 filas en formato JSON.',
      parameters: {
        type: 'object',
        properties: {
          sql: {
            type: 'string',
            description: 'Consulta SQL de solo lectura válida para MySQL 8 (SELECT, SHOW, DESCRIBE, EXPLAIN o WITH).'
          }
        },
        required: ['sql']
      }
    }
  }
];

function validateReadOnlySql(rawSql) {
  if (typeof rawSql !== 'string' || !rawSql.trim()) {
    throw new Error('La consulta SQL no puede estar vacía.');
  }

  // Eliminar punto y coma final opcional y espacios
  const cleanSql = rawSql.trim().replace(/;+\s*$/, '').trim();

  // Eliminar comentarios SQL y literales de cadena solo para validación de seguridad
  const sqlWithoutStringsAndComments = cleanSql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/'(?:\\.|''|[^'])*'/g, "''")
    .replace(/"(?:\\.|""|[^"])*"/g, '""')
    .trim();

  if (sqlWithoutStringsAndComments.includes(';')) {
    throw new Error('No se permiten múltiples sentencias SQL.');
  }

  if (!/^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i.test(sqlWithoutStringsAndComments)) {
    throw new Error('Solo se permiten consultas de solo lectura (SELECT, SHOW, DESCRIBE, EXPLAIN, WITH).');
  }

  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|GRANT|REVOKE|CALL|LOCK|UNLOCK|SET|INTO\s+OUTFILE|INTO\s+DUMPFILE)\b/i.test(sqlWithoutStringsAndComments)) {
    throw new Error('La consulta contiene palabras clave de escritura o administración no permitidas.');
  }

  return cleanSql;
}

async function runQuery(sql) {
  try {
    const cleanSql = validateReadOnlySql(sql);
    console.log('[SQL]:', cleanSql);

    const [rows] = await pool.query(cleanSql);

    if (!Array.isArray(rows)) {
      return { result: rows };
    }

    const totalRows = rows.length;
    const limitedRows = rows.slice(0, MAX_ROWS);

    return {
      rowCount: totalRows,
      truncated: totalRows > MAX_ROWS,
      rows: limitedRows
    };
  } catch (error) {
    console.error('[SQL Error]:', error.message);
    return {
      error: error.message
    };
  }
}

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
      { role: 'system', content: SYSTEM_PROMPT },
      ...previousMessages,
      { role: 'user', content: message.trim() }
    ];

    let reply = null;

    // Ciclo de tool calling con Sakila
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const completion = await openrouter.chat.completions.create({
        model: process.env.OPENROUTER_MODEL,
        messages,
        tools
      });

      const assistantMessage = completion.choices[0]?.message;

      if (!assistantMessage) {
        break;
      }

      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        messages.push({
          role: 'assistant',
          content: assistantMessage.content || null,
          tool_calls: assistantMessage.tool_calls
        });

        for (const toolCall of assistantMessage.tool_calls) {
          let toolOutput;

          if (toolCall.function?.name === 'execute_sql') {
            try {
              const args = JSON.parse(toolCall.function.arguments || '{}');
              toolOutput = await runQuery(args.sql);
            } catch (parseError) {
              toolOutput = { error: `Argumentos inválidos: ${parseError.message}` };
            }
          } else {
            toolOutput = { error: `Herramienta desconocida: ${toolCall.function?.name}` };
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolOutput)
          });
        }
      } else {
        reply = assistantMessage.content;
        break;
      }
    }

    // Si alcanzó el límite de iteraciones sin respuesta final de texto, solicitar resumen final sin herramientas
    if (!reply) {
      const finalCompletion = await openrouter.chat.completions.create({
        model: process.env.OPENROUTER_MODEL,
        messages
      });
      reply = finalCompletion.choices[0]?.message?.content;
    }

    if (!reply) {
      return res.status(502).json({
        error: 'La IA no devolvió una respuesta.'
      });
    }

    // Enviar respuesta al frontend
    res.json({ reply });

  } catch (error) {
    console.error('Error de OpenRouter o BD:', error);

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
