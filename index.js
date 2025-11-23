require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const port = process.env.PORT || 3000;

// ===================================
// === MIDDLEWARES GLOBAIS
// ===================================
app.use(cors());
app.use(express.json());

// MIDDLEWARE DE LOG (Para debug)
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.path}`);
  next();
});

// --- CONFIGURAÇÃO DO BANCO DE DADOS ---
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("ERRO: DATABASE_URL não encontrada.");
  process.exit(1);
}

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  console.error("ERRO: JWT_SECRET não encontrado no .env");
  process.exit(1);
}

// Cria a pool de conexão
const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false,
  },
});

// ✅ EXPORTA A POOL AQUI (ANTES DE IMPORTAR ROTAS)
module.exports = { pool };

// Testa a conexão
pool.connect((err, client, release) => {
  if (err) {
    console.error("❌ Erro ao conectar ao banco de dados:", err.message);
  } else {
    console.log("✅ Conectado ao banco de dados PostgreSQL (Neon)");
    release();
  }
});

// ===================================
// === IMPORTA ROTAS (DEPOIS DA EXPORTAÇÃO)
// ===================================
const authRoutes = require("./routes/authRoutes");

// ===================================
// === MIDDLEWARE DE AUTENTICAÇÃO
// ===================================
function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (token == null) {
    return res
      .status(401)
      .json({ error: "Acesso não autorizado. Token não fornecido." });
  }

  jwt.verify(token, jwtSecret, (err, usuario) => {
    if (err) {
      console.error("❌ Token inválido:", err.message);
      return res
        .status(403)
        .json({ error: "Acesso proibido. Token inválido." });
    }
    req.usuario = usuario;
    next();
  });
}

// ===================================
// === ROTAS DE AUTENTICAÇÃO
// ===================================

// Rotas de autenticação (Redefinição de senha)
app.use("/api", authRoutes); // Todas as rotas em authRoutes.js começarão com /api

// REGISTRO
app.post("/api/register", async (req, res) => {
  try {
    const { nome, email, senha } = req.body;

    if (!nome || !email || !senha) {
      return res
        .status(400)
        .json({ error: "Nome, email e senha são obrigatórios." });
    }

    const userExists = await pool.query(
      "SELECT * FROM usuarios WHERE email = $1",
      [email]
    );

    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: "Este email já está cadastrado." });
    }

    const salt = await bcrypt.genSalt(10);
    const senha_hash = await bcrypt.hash(senha, salt);

    const newUser = await pool.query(
      "INSERT INTO usuarios (nome, email, senha_hash) VALUES ($1, $2, $3) RETURNING id, email, nome",
      [nome, email, senha_hash]
    );

    res.status(201).json({
      id: newUser.rows[0].id,
      email: newUser.rows[0].email,
      nome: newUser.rows[0].nome,
    });
  } catch (error) {
    console.error("Erro no registro:", error.message);
    res.status(500).json({ error: "Erro interno do servidor." });
  }
});

// LOGIN
app.post("/api/login", async (req, res) => {
  try {
    const { email, senha } = req.body;

    if (!email || !senha) {
      return res.status(400).json({ error: "Email e senha são obrigatórios." });
    }

    const userResult = await pool.query(
      "SELECT * FROM usuarios WHERE email = $1",
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: "Email ou senha inválidos." });
    }

    const user = userResult.rows[0];

    const senhaCorreta = await bcrypt.compare(senha, user.senha_hash);
    if (!senhaCorreta) {
      return res.status(401).json({ error: "Email ou senha inválidos." });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, nome: user.nome },
      jwtSecret,
      { expiresIn: "8h" }
    );

    res.status(200).json({
      token: token,
      usuario: {
        id: user.id,
        email: user.email,
        nome: user.nome,
      },
    });
  } catch (error) {
    console.error("Erro no login:", error.message);
    res.status(500).json({ error: "Erro interno do servidor." });
  }
});

// ===================================
// === FUNÇÕES DA LOTOFÁCIL
// ===================================
async function getUltimoSalvo() {
  try {
    const result = await pool.query(
      "SELECT concurso FROM resultados ORDER BY concurso DESC LIMIT 1"
    );
    if (result.rows.length > 0) {
      return result.rows[0].concurso;
    }
    return 0;
  } catch (error) {
    console.error("Erro ao buscar último concurso:", error.message);
    return 0;
  }
}

function normalizarConcurso(data) {
  const [dia, mes, ano] = data.dataApuracao.split("/");
  const dataFormatada = `${ano}-${mes}-${dia}`;
  return {
    concurso: data.numero,
    data: dataFormatada,
    dezenas: data.listaDezenas.join(" "),
  };
}

async function salvarConcurso(doc) {
  const query = `
    INSERT INTO resultados (concurso, data, dezenas)
    VALUES ($1, $2, $3)
    ON CONFLICT (concurso) DO NOTHING
  `;
  try {
    await pool.query(query, [doc.concurso, doc.data, doc.dezenas]);
    console.log(`✅ Concurso ${doc.concurso} salvo com sucesso!`);
    return true;
  } catch (error) {
    console.error(`⚠️ Erro ao salvar concurso ${doc.concurso}:`, error.message);
    return false;
  }
}

async function syncLotofacil() {
  try {
    const ultimoSalvo = await getUltimoSalvo();
    console.log("Último salvo no banco:", ultimoSalvo);

    const { data: ultimaApi } = await axios.get(
      "https://api.guidi.dev.br/loteria/lotofacil/ultimo"
    );
    const ultimoApiNumero = Number(ultimaApi.numero);
    console.log("Último disponível na API:", ultimoApiNumero);

    if (ultimoSalvo >= ultimoApiNumero) {
      console.log("Banco já está atualizado ✅");
      return {
        message: "Banco já está atualizado",
        concursosAdicionados: 0,
        ultimoConcurso: ultimoSalvo,
      };
    }

    let concursosAdicionados = 0;
    for (let i = ultimoSalvo + 1; i <= ultimoApiNumero; i++) {
      try {
        const { data } = await axios.get(
          `https://api.guidi.dev.br/loteria/lotofacil/${i}`
        );
        const doc = normalizarConcurso(data);
        const salvou = await salvarConcurso(doc);
        if (salvou) {
          concursosAdicionados++;
        }
      } catch (err) {
        console.error(`⚠️ Erro ao salvar concurso ${i}:`, err.message);
      }
    }

    console.log("Sincronização concluída 🚀");
    return {
      message: "Sincronização concluída com sucesso",
      concursosAdicionados: concursosAdicionados,
      ultimoConcurso: ultimoApiNumero,
    };
  } catch (error) {
    console.error("Erro na sincronização:", error.message);
    throw error;
  }
}

// ===================================
// === ROTAS DE RESULTADOS
// ===================================
app.get("/api/resultados", authMiddleware, async (req, res) => {
  console.log(`✅ Usuário ${req.usuario.email} buscando resultados...`);

  const limit = parseInt(req.query.limit) || 10;

  try {
    const query = `
      SELECT concurso, data, dezenas 
      FROM resultados
      ORDER BY concurso DESC
      LIMIT $1;
    `;
    const { rows } = await pool.query(query, [limit]);
    res.json(rows);
  } catch (error) {
    console.error("Erro ao buscar resultados:", error);
    res.status(500).json({ error: "Erro ao buscar resultados" });
  }
});

// ===================================
// === ROTAS DE FECHAMENTOS
// ===================================

// LISTAR OPÇÕES DE FECHAMENTOS DISPONÍVEIS
app.get("/api/fechamentos/opcoes", authMiddleware, async (req, res) => {
  console.log(
    `✅ Usuário ${req.usuario.email} buscando opções de fechamentos...`
  );

  try {
    const query = `
      SELECT 
        codigo, 
        dados->>'universo' as universo,
        dados->>'custo' as custo
      FROM fechamentos 
      ORDER BY (dados->>'universo')::int
    `;

    const { rows } = await pool.query(query);

    const opcoes = rows.map((row) => ({
      codigo: row.codigo,
      universo: parseInt(row.universo),
      custo: parseInt(row.custo),
      descricao: `Garantir 15 se acertar 15 (${row.universo} dezenas - ${row.custo} jogos)`,
    }));

    console.log(`✅ ${opcoes.length} opções de fechamento encontradas`);
    res.json(opcoes);
  } catch (error) {
    console.error("❌ Erro ao listar fechamentos:", error.message);
    res.status(500).json({ error: "Erro ao listar fechamentos disponíveis" });
  }
});

// BUSCAR FECHAMENTO ESPECÍFICO
app.get("/api/fechamento/:codigo", authMiddleware, async (req, res) => {
  const { codigo } = req.params;
  console.log(`✅ Usuário ${req.usuario.email} buscando fechamento: ${codigo}`);

  try {
    const sqlQuery = "SELECT dados FROM fechamentos WHERE codigo = $1";
    const { rows } = await pool.query(sqlQuery, [codigo]);

    if (rows.length === 0) {
      console.log(`❌ Fechamento '${codigo}' não encontrado.`);
      return res.status(404).json({ error: "Fechamento não encontrado" });
    }

    res.status(200).json(rows[0].dados);
  } catch (error) {
    console.error("❌ Erro ao buscar fechamento:", error.message);
    res
      .status(500)
      .json({ error: "Erro interno do servidor.", detalhes: error.message });
  }
});

// ===================================
// === ROTAS DE JOGOS SALVOS
// ===================================

// SALVAR UM JOGO (Individual)
app.post("/api/jogos/salvar", authMiddleware, async (req, res) => {
  console.log("📥 POST /api/jogos/salvar");

  const { dezenas } = req.body;
  const usuario_id = req.usuario.id;

  if (!dezenas || typeof dezenas !== "string") {
    return res.status(400).json({ error: "Formato de dezenas inválido." });
  }

  try {
    const query = `
      INSERT INTO jogos_salvos (dezenas, usuario_id)
      VALUES ($1, $2)
      RETURNING *; 
    `;
    const { rows } = await pool.query(query, [dezenas, usuario_id]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error("Erro ao salvar jogo:", error.message);
    res.status(500).json({ error: "Erro interno ao salvar o jogo." });
  }
});

// SALVAR EM LOTE (BULK)
app.post("/api/jogos/salvar-lote", authMiddleware, async (req, res) => {
  console.log("📥 POST /api/jogos/salvar-lote");
  console.log("Body recebido:", req.body);
  console.log("Usuário:", req.usuario.email);

  const { jogos } = req.body;
  const usuario_id = req.usuario.id;

  // Validação detalhada
  if (!jogos) {
    console.error("❌ Campo 'jogos' não enviado");
    return res.status(400).json({
      error: "Campo 'jogos' é obrigatório.",
      recebido: req.body,
    });
  }

  if (!Array.isArray(jogos)) {
    console.error("❌ 'jogos' não é um array");
    return res.status(400).json({
      error: "Campo 'jogos' deve ser um array.",
      tipo_recebido: typeof jogos,
    });
  }

  if (jogos.length === 0) {
    console.error("❌ Array de jogos está vazio");
    return res.status(400).json({ error: "Array de jogos está vazio." });
  }

  // Limite de segurança
  const MAX_JOGOS = 1000;
  if (jogos.length > MAX_JOGOS) {
    return res.status(400).json({
      error: `Máximo de ${MAX_JOGOS} jogos por vez.`,
      enviados: jogos.length,
    });
  }

  console.log(`✅ Validação OK: ${jogos.length} jogos para salvar`);

  // Query otimizada usando unnest
  const query = `
    INSERT INTO jogos_salvos (dezenas, usuario_id)
    SELECT 
      dezenas_val, $2 
    FROM unnest($1::text[]) AS dezenas_val
    RETURNING id; 
  `;

  try {
    console.log("💾 Salvando no banco...");
    const { rows } = await pool.query(query, [jogos, usuario_id]);

    console.log(`✅ ${rows.length} jogos salvos com sucesso!`);

    res.status(201).json({
      success: true,
      message: `${rows.length} jogo(s) salvo(s) com sucesso.`,
      jogosSalvos: rows.length,
    });
  } catch (error) {
    console.error("❌ Erro ao salvar jogos em lote:", error);
    res.status(500).json({
      error: "Erro interno ao salvar os jogos.",
      detalhes: error.message,
    });
  }
});

// BUSCAR JOGOS DO USUÁRIO
app.get("/api/jogos/meus-jogos", authMiddleware, async (req, res) => {
  console.log("📥 GET /api/jogos/meus-jogos");

  const usuario_id = req.usuario.id;

  try {
    const query = `
      SELECT id, dezenas, data_criacao 
      FROM jogos_salvos
      WHERE usuario_id = $1
      ORDER BY data_criacao DESC;
    `;
    const { rows } = await pool.query(query, [usuario_id]);
    console.log(`✅ ${rows.length} jogos encontrados`);
    res.status(200).json(rows);
  } catch (error) {
    console.error("Erro ao buscar jogos:", error.message);
    res.status(500).json({ error: "Erro interno ao buscar seus jogos." });
  }
});

// DELETAR JOGOS
app.post("/api/jogos/delete", authMiddleware, async (req, res) => {
  console.log("📥 POST /api/jogos/delete");

  const { ids } = req.body;
  const usuario_id = req.usuario.id;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "IDs de jogos inválidos." });
  }

  try {
    const query = `
      DELETE FROM jogos_salvos
      WHERE id = ANY($1::int[]) AND usuario_id = $2;
    `;
    const result = await pool.query(query, [ids, usuario_id]);

    if (result.rowCount > 0) {
      console.log(`✅ ${result.rowCount} jogos deletados`);
      res.status(200).json({
        message: `${result.rowCount} jogo(s) deletado(s) com sucesso.`,
      });
    } else {
      res.status(404).json({
        error: "Nenhum jogo encontrado para deletar.",
      });
    }
  } catch (error) {
    console.error("Erro ao deletar jogos:", error.message);
    res.status(500).json({ error: "Erro interno ao deletar jogos." });
  }
});

// ===================================
// === ROTAS DE BOLÕES/GRUPOS
// ===================================

// LISTAR BOLÕES DO USUÁRIO
app.get("/api/boloes", authMiddleware, async (req, res) => {
  console.log(`✅ Usuário ${req.usuario.email} buscando bolões...`);

  const usuario_id = req.usuario.id;

  try {
    const query = `
      SELECT 
        b.id, 
        b.nome, 
        b.data_criacao,
        COUNT(j.id) as total_jogos
      FROM boloes b
      LEFT JOIN jogos_salvos j ON j.bolao_id = b.id
      WHERE b.usuario_id = $1
      GROUP BY b.id, b.nome, b.data_criacao
      ORDER BY b.data_criacao DESC;
    `;

    const { rows } = await pool.query(query, [usuario_id]);
    console.log(`✅ ${rows.length} bolões encontrados`);
    res.status(200).json(rows);
  } catch (error) {
    console.error("Erro ao buscar bolões:", error.message);
    res.status(500).json({ error: "Erro interno ao buscar bolões." });
  }
});

// CRIAR NOVO BOLÃO
app.post("/api/boloes", authMiddleware, async (req, res) => {
  console.log("📥 POST /api/boloes");

  const { nome } = req.body;
  const usuario_id = req.usuario.id;

  if (!nome || nome.trim() === "") {
    return res.status(400).json({ error: "Nome do bolão é obrigatório." });
  }

  try {
    const query = `
      INSERT INTO boloes (nome, usuario_id)
      VALUES ($1, $2)
      RETURNING id, nome, data_criacao;
    `;

    const { rows } = await pool.query(query, [nome.trim(), usuario_id]);
    console.log(`✅ Bolão '${nome}' criado com ID ${rows[0].id}`);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error("Erro ao criar bolão:", error.message);
    res.status(500).json({ error: "Erro interno ao criar bolão." });
  }
});

// ATUALIZAR NOME DO BOLÃO
app.put("/api/boloes/:id", authMiddleware, async (req, res) => {
  console.log("📥 PUT /api/boloes/:id");

  const { id } = req.params;
  const { nome } = req.body;
  const usuario_id = req.usuario.id;

  if (!nome || nome.trim() === "") {
    return res.status(400).json({ error: "Nome do bolão é obrigatório." });
  }

  try {
    const query = `
      UPDATE boloes 
      SET nome = $1 
      WHERE id = $2 AND usuario_id = $3
      RETURNING id, nome, data_criacao;
    `;

    const { rows } = await pool.query(query, [nome.trim(), id, usuario_id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Bolão não encontrado." });
    }

    console.log(`✅ Bolão ${id} atualizado`);
    res.status(200).json(rows[0]);
  } catch (error) {
    console.error("Erro ao atualizar bolão:", error.message);
    res.status(500).json({ error: "Erro interno ao atualizar bolão." });
  }
});

// DELETAR BOLÃO
app.delete("/api/boloes/:id", authMiddleware, async (req, res) => {
  console.log("📥 DELETE /api/boloes/:id");

  const { id } = req.params;
  const usuario_id = req.usuario.id;

  try {
    // Primeiro, desassocia os jogos (seta bolao_id = NULL)
    await pool.query(
      "UPDATE jogos_salvos SET bolao_id = NULL WHERE bolao_id = $1",
      [id]
    );

    // Depois deleta o bolão
    const query = `
      DELETE FROM boloes 
      WHERE id = $1 AND usuario_id = $2
      RETURNING id;
    `;

    const { rows } = await pool.query(query, [id, usuario_id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Bolão não encontrado." });
    }

    console.log(`✅ Bolão ${id} deletado`);
    res.status(200).json({ message: "Bolão deletado com sucesso." });
  } catch (error) {
    console.error("Erro ao deletar bolão:", error.message);
    res.status(500).json({ error: "Erro interno ao deletar bolão." });
  }
});

// SALVAR EM LOTE COM BOLÃO
app.post(
  "/api/jogos/salvar-lote-com-bolao",
  authMiddleware,
  async (req, res) => {
    console.log("📥 POST /api/jogos/salvar-lote-com-bolao");

    const { jogos, bolao_id } = req.body;
    const usuario_id = req.usuario.id;

    // Validações
    if (!jogos || !Array.isArray(jogos) || jogos.length === 0) {
      return res.status(400).json({ error: "Array de jogos inválido." });
    }

    const MAX_JOGOS = 1000;
    if (jogos.length > MAX_JOGOS) {
      return res.status(400).json({
        error: `Máximo de ${MAX_JOGOS} jogos por vez.`,
      });
    }

    console.log(`✅ Validação OK: ${jogos.length} jogos para salvar`);
    console.log(`📌 Bolão ID: ${bolao_id || "Nenhum"}`);

    try {
      const query = `
      INSERT INTO jogos_salvos (dezenas, usuario_id, bolao_id)
      SELECT 
        dezenas_val, $2, $3
      FROM unnest($1::text[]) AS dezenas_val
      RETURNING id; 
    `;

      const { rows } = await pool.query(query, [
        jogos,
        usuario_id,
        bolao_id || null,
      ]);

      console.log(`✅ ${rows.length} jogos salvos com sucesso!`);

      res.status(201).json({
        success: true,
        message: `${rows.length} jogo(s) salvo(s) com sucesso.`,
        jogosSalvos: rows.length,
      });
    } catch (error) {
      console.error("❌ Erro ao salvar jogos em lote:", error);
      res.status(500).json({
        error: "Erro interno ao salvar os jogos.",
        detalhes: error.message,
      });
    }
  }
);

// BUSCAR JOGOS COM FILTRO DE BOLÃO
app.get("/api/jogos/meus-jogos-filtrado", authMiddleware, async (req, res) => {
  console.log("📥 GET /api/jogos/meus-jogos-filtrado");

  const usuario_id = req.usuario.id;
  const { bolao_id } = req.query;

  try {
    let query = `
      SELECT j.id, j.dezenas, j.data_criacao, j.bolao_id, b.nome as bolao_nome
      FROM jogos_salvos j
      LEFT JOIN boloes b ON j.bolao_id = b.id
      WHERE j.usuario_id = $1
    `;

    const params = [usuario_id];

    if (bolao_id) {
      if (bolao_id === "sem-bolao") {
        query += ` AND j.bolao_id IS NULL`;
      } else {
        query += ` AND j.bolao_id = $2`;
        params.push(bolao_id);
      }
    }

    query += ` ORDER BY j.data_criacao DESC;`;

    const { rows } = await pool.query(query, params);
    console.log(`✅ ${rows.length} jogos encontrados`);
    res.status(200).json(rows);
  } catch (error) {
    console.error("Erro ao buscar jogos:", error.message);
    res.status(500).json({ error: "Erro interno ao buscar seus jogos." });
  }
});

// ===================================
// === ROTAS FINAIS
// ===================================

// Worker de sincronização
app.all("/api/worker/run", async (req, res) => {
  console.log("📥 Worker /api/worker/run chamado...");
  try {
    const resultado = await syncLotofacil();
    res.status(200).json(resultado);
  } catch (error) {
    res.status(500).json({
      error: "Erro ao executar sincronização",
      message: error.message,
    });
  }
});

// Rota raiz
app.get("/", (req, res) => {
  res.send("API da Lotofácil (PostgreSQL + Express) está no ar. ✅");
});

// Rota de teste
app.get("/api/test", (req, res) => {
  res.json({
    status: "ok",
    message: "API funcionando!",
    rotas_disponiveis: [
      "POST /api/register",
      "POST /api/login",
      "POST /api/forgot-password",
      "POST /api/reset-password",
      "GET /api/resultados",
      "POST /api/jogos/salvar",
      "POST /api/jogos/salvar-lote",
      "GET /api/jogos/meus-jogos",
      "POST /api/jogos/delete",
      "GET /api/fechamentos/opcoes",
      "GET /api/fechamento/:codigo",
      "GET /api/boloes",
      "POST /api/boloes",
    ],
  });
});

// Middleware para rotas não encontradas (404)
app.use((req, res) => {
  console.log(`❌ 404 - Rota não encontrada: ${req.method} ${req.path}`);
  res.status(404).json({
    error: "Rota não encontrada",
    path: req.path,
    method: req.method,
    sugestao: "Verifique se a URL está correta",
  });
});

// Inicia o servidor
app.listen(port, () => {
  console.log(`🚀 API da Lotofácil rodando na porta ${port}`);
  console.log(`📍 URL: http://localhost:${port}`);
  console.log(`✅ Rotas disponíveis:`);
  console.log(`   POST /api/register`);
  console.log(`   POST /api/login`);
  console.log(`   POST /api/forgot-password`);
  console.log(`   POST /api/reset-password`);
  console.log(`   GET  /api/resultados`);
  console.log(`   POST /api/jogos/salvar-lote`);
  console.log(`   GET  /api/jogos/meus-jogos`);
  console.log(`   POST /api/jogos/delete`);
  console.log(`   GET  /api/fechamentos/opcoes`);
  console.log(`   GET  /api/fechamento/:codigo`);
  console.log(`   GET  /api/boloes`);
  console.log(`   POST /api/boloes`);
});
