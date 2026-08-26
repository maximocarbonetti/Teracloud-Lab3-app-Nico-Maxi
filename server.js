const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');

const app = express();

// El target group del ALB apunta al puerto 80 (var.frontend_container_port).
// Por eso el default es 80 y no 3000: asi no hace falta inyectar PORT desde
// la task definition.
const PORT = process.env.PORT || 80;

// --- Configuracion de conexion a MySQL ---
// Se aceptan los dos juegos de nombres de variables:
//   MYSQL_* -> convencion que traia la app del Lab 2
//   DB_*    -> convencion que ya inyecta la task definition de este lab
//              (ver frontend_secrets en environments/dev/main.tf)
// De esta forma la app funciona sin tocar Terraform.
const dbConfig = {
  host: process.env.MYSQL_HOST || process.env.DB_HOST,
  port: process.env.MYSQL_PORT || process.env.DB_PORT || 3306,
  database: process.env.MYSQL_DATABASE || process.env.DB_NAME,
  user: process.env.MYSQL_USER || process.env.DB_USER,
  password: process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 5,
};

let pool;
let dbReady = false;

// Crea el pool y la tabla si no existe. Reintenta cada 5s por si la task de
// MySQL todavia no esta lista (arranque en frio o reemplazo de task).
async function initDb() {
  try {
    pool = mysql.createPool(dbConfig);

    const conn = await pool.getConnection();

    await conn.query(`
      CREATE TABLE IF NOT EXISTS notas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        titulo VARCHAR(120) NOT NULL DEFAULT 'Tomo sin titulo',
        texto VARCHAR(1000) NOT NULL,
        autor VARCHAR(80) NOT NULL DEFAULT 'Viajero anonimo',
        fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migraciones para bases creadas antes de que existieran estas columnas.
    // El error 1060 (columna duplicada) significa que ya se aplicaron.
    const migraciones = [
      ["autor",  "ALTER TABLE notas ADD COLUMN autor VARCHAR(80) NOT NULL DEFAULT 'Viajero anonimo'"],
      ["titulo", "ALTER TABLE notas ADD COLUMN titulo VARCHAR(120) NOT NULL DEFAULT 'Tomo sin titulo'"],
    ];

    for (const [columna, sql] of migraciones) {
      try {
        await conn.query(sql);
        console.log(`[db] Columna "${columna}" agregada a una tabla preexistente.`);
      } catch (err) {
        if (err.errno !== 1060) throw err;
      }
    }

    conn.release();

    dbReady = true;
    console.log(`[db] Conectado a MySQL en ${dbConfig.host}:${dbConfig.port}, tabla "notas" lista.`);
  } catch (err) {
    dbReady = false;
    console.error(`[db] No se pudo conectar/inicializar (${err.code || err.message}). Reintentando en 5s...`);
    setTimeout(initDb, 5000);
  }
}

initDb();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Health check ---
// Devuelve 200 apenas el server HTTP esta arriba, independientemente del
// estado de la DB, para no tumbar el target group por un problema transitorio
// de MySQL.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', db: dbReady ? 'connected' : 'connecting' });
});

// --- API: listar notas ---
app.get('/api/notas', async (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: 'El salon todavia no abrio sus puertas. Reintentando conexion.' });
  }
  try {
    const [rows] = await pool.query(
      'SELECT id, titulo, texto, autor, fecha_creacion FROM notas ORDER BY fecha_creacion DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error('[api] Error al listar notas:', err.message);
    res.status(500).json({ error: 'No se pudieron leer los tomos de la biblioteca.' });
  }
});

// --- API: crear nota ---
app.post('/api/notas', async (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: 'El salon todavia no abrio sus puertas. Reintentando conexion.' });
  }

  const { titulo, texto, autor } = req.body;

  if (!texto || !texto.trim()) {
    return res.status(400).json({ error: 'Un tomo vacio no cuenta ninguna historia.' });
  }

  const nombreAutor = (autor || '').trim().slice(0, 80) || 'Viajero anonimo';
  const tituloTomo  = (titulo || '').trim().slice(0, 120) || 'Tomo sin titulo';

  try {
    const [result] = await pool.query(
      'INSERT INTO notas (titulo, texto, autor) VALUES (?, ?, ?)',
      [tituloTomo, texto.trim(), nombreAutor]
    );
    res.status(201).json({
      id: result.insertId,
      titulo: tituloTomo,
      texto: texto.trim(),
      autor: nombreAutor,
    });
  } catch (err) {
    console.error('[api] Error al crear nota:', err.message);
    res.status(500).json({ error: 'El tomo no pudo grabarse en la biblioteca.' });
  }
});

// --- API: borrar nota ---
// No hay sistema de login, asi que la unica validacion posible es que el
// autor que envia el pedido coincida con el que figura en la fila. No es
// seguridad real (cualquiera podria mandar otro nombre), pero evita el
// borrado accidental de notas ajenas desde la interfaz.
app.delete('/api/notas/:id', async (req, res) => {
  // Primero la forma del pedido, despues el estado de la base: asi un
  // pedido malformado recibe un 400 claro aunque MySQL este arrancando.
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Ese tomo no existe en la biblioteca.' });
  }

  const autor = (req.body?.autor || '').trim();
  if (!autor) {
    return res.status(400).json({ error: 'Falta saber quien pide quemar el tomo.' });
  }

  if (!dbReady) {
    return res.status(503).json({ error: 'El salon todavia no abrio sus puertas.' });
  }

  try {
    const [filas] = await pool.query('SELECT autor FROM notas WHERE id = ?', [id]);
    if (!filas.length) {
      return res.status(404).json({ error: 'Ese tomo ya no esta en la biblioteca.' });
    }

    if (filas[0].autor.trim().toLowerCase() !== autor.toLowerCase()) {
      return res.status(403).json({ error: 'Solo quien escribio el tomo puede quemarlo.' });
    }

    await pool.query('DELETE FROM notas WHERE id = ?', [id]);
    console.log(`[api] Nota ${id} borrada por ${autor}.`);
    res.json({ id, borrada: true });
  } catch (err) {
    console.error('[api] Error al borrar nota:', err.message);
    res.status(500).json({ error: 'El tomo se resiste a arder.' });
  }
});

app.listen(PORT, () => {
  console.log(`[server] Sovngarde Notes escuchando en el puerto ${PORT}`);
});
