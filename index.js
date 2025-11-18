require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// --- MERCADO PAGO ---
// Importando as classes necessárias da SDK v2
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");

const app = express();
const port = process.env.PORT || 3000;

// ===================================
// === CONFIGURAÇÕES GLOBAIS
// ===================================

app.use(cors());
app.use(express.json());

// MIDDLEWARE DE LOG (Para debug)
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.path}`);
  next();
});

// --- CONFIGURAÇÃO DO BANCO DE DADOS E SEGURANÇA ---
// 1. Validar DATABASE_URL
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("ERRO: DATABASE_URL não encontrada.");
  process.exit(1);
}

// 2. Definir e Validar JWT_SECRET (CORREÇÃO APLICADA AQUI)
const jwtSecret = process.env.JWT_SECRET; // <-- Definido antes de usar
if (!jwtSecret) {
  console.error("ERRO: JWT_SECRET não encontrado no .env");
  process.exit(1);
}

// Adicionado 'ssl' para compatibilidade com NeonDB / Vercel Postgres
const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false,
  },
});

// --- CONFIGURAÇÃO MERCADO PAGO ---
// Inicializa o cliente com o Access Token do .env
// Garanta que MP_ACCESS_TOKEN esteja no seu arquivo .env
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// ===================================
// === MIDDLEWARE DE AUTENTICAÇÃO
// ===================================
function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Token não fornecido." });

  jwt.verify(token, jwtSecret, (err, usuario) => {
    if (err) return res.status(403).json({ error: "Token inválido." });
    req.usuario = usuario;
    next();
  });
}

async function checkPremiumMiddleware(req, res, next) {
  if (!req.usuario)
    return res.status(401).json({ error: "Autenticação necessária." });
  const usuarioId = req.usuario.id;

  try {
    const { rows } = await pool.query(
      "SELECT plano, plano_expira_em FROM usuarios WHERE id = $1",
      [usuarioId]
    );

    if (rows.length === 0)
      return res.status(404).json({ error: "Usuário não encontrado." });

    const user = rows[0];
    const hoje = new Date();

    // Verifica se é premium E se a data de expiração é futura
    if (user.plano === "premium" && new Date(user.plano_expira_em) > hoje) {
      next(); // Acesso permitido
    } else {
      res.status(403).json({
        error: "Recurso exclusivo Premium.",
        isPremium: false,
      });
    }
  } catch (error) {
    console.error("Erro middleware premium:", error);
    res.status(500).json({ error: "Erro interno." });
  }
}

// ===================================
// === ROTAS DE PAGAMENTO (MERCADO PAGO)
// ===================================

// 1. CRIAR PREFERÊNCIA DE PAGAMENTO
app.post(
  "/api/pagamento/criar-assinatura",
  authMiddleware,
  async (req, res) => {
    const usuarioId = req.usuario.id;
    const email = req.usuario.email;

    try {
      // URL do seu Backend (para o webhook)
      const apiUrl =
        "https://criadordigital-api-lotofacil-postgres.51xxn7.easypanel.host";

      // URL do seu Front-end (para redirecionar após pagamento)
      // IMPORTANTE: Ajuste para a URL real do seu site quando for para produção
      const frontUrl = "https://projeto-lotofacil-api.vercel.app/index.html"; // <--- AJUSTAR ISSO

      const preference = new Preference(client);

      const body = {
        items: [
          {
            id: "plano-premium-30d",
            title: "Acesso Premium - Lotofácil (30 Dias)",
            quantity: 1,
            unit_price: 19.9, // Preço do plano
            currency_id: "BRL",
          },
        ],
        payer: {
          email: email,
        },
        // O 'external_reference' é CRUCIAL. É aqui que guardamos o ID do usuário
        external_reference: usuarioId.toString(),

        // Configurações de retorno
        back_urls: {
          success: `${frontUrl}/app.html`, // Redireciona para o app logado
          failure: `${frontUrl}/erro.html`,
          pending: `${frontUrl}/pendente.html`,
        },
        auto_return: "approved",

        // URL onde o Mercado Pago vai avisar que o pagamento ocorreu
        notification_url: `${apiUrl}/api/pagamento/webhook`,
      };

      const result = await preference.create({ body });

      // Retorna o link de pagamento (init_point)
      res.json({ urlPagamento: result.init_point });
    } catch (error) {
      console.error("Erro ao criar preferência:", error);
      res.status(500).json({ error: "Erro ao gerar pagamento." });
    }
  }
);

// 2. WEBHOOK (Recebe notificação do Mercado Pago)
app.post("/api/pagamento/webhook", async (req, res) => {
  const { type, data } = req.body;

  // O Mercado Pago manda vários tipos de notificação.
  const topic = req.query.topic || type;
  const id = req.query.id || data?.id;

  if (topic === "payment" && id) {
    try {
      console.log(`🔔 Webhook recebido. Pagamento ID: ${id}`);

      // Consulta o Mercado Pago para ver o status real do pagamento
      const payment = new Payment(client);
      const pagamentoInfo = await payment.get({ id });

      // Verifica se foi APROVADO
      if (pagamentoInfo.status === "approved") {
        const usuarioId = pagamentoInfo.external_reference; // Pegamos o ID do usuário de volta

        if (usuarioId) {
          // Atualiza o banco de dados: define como premium por 30 dias
          await pool.query(
            `UPDATE usuarios 
             SET plano = 'premium', 
                 plano_expira_em = NOW() + INTERVAL '30 days' 
             WHERE id = $1`,
            [usuarioId]
          );
          console.log(`✅ Usuário ${usuarioId} virou PREMIUM!`);
        }
      }
    } catch (error) {
      console.error("Erro ao processar webhook:", error);
    }
  }

  // Sempre responda 200 OK para o Mercado Pago
  res.status(200).send("OK");
});

// ===================================
// === ROTAS DE AUTENTICAÇÃO
// ===================================

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

    // Insere o usuário. O padrão do plano é 'gratis' definido no banco,
    // mas podemos forçar aqui se quiser.
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
        // Podemos retornar o plano aqui se quiser mostrar no front
        plano: user.plano,
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
        dados->>'custo' as custo,
        descricao -- Se você tiver a coluna descricao
      FROM fechamentos 
      ORDER BY (dados->>'universo')::int
    `;

    const { rows } = await pool.query(query);

    const opcoes = rows.map((row) => ({
      codigo: row.codigo,
      universo: parseInt(row.universo),
      custo: parseInt(row.custo),
      // Usa a descrição do banco ou cria uma padrão
      descricao:
        row.descricao ||
        `Garantir 15 se acertar 15 (${row.universo} dezenas - ${row.custo} jogos)`,
    }));

    console.log(`✅ ${opcoes.length} opções de fechamento encontradas`);
    res.json(opcoes);
  } catch (error) {
    console.error("❌ Erro ao listar fechamentos:", error.message);
    res.status(500).json({ error: "Erro ao listar fechamentos disponíveis" });
  }
});

// BUSCAR FECHAMENTO ESPECÍFICO (PREMIUM)
app.get(
  "/api/fechamento/:codigo",
  authMiddleware,
  checkPremiumMiddleware,
  async (req, res) => {
    const { codigo } = req.params;
    console.log(
      `✅ Usuário PREMIUM ${req.usuario.email} buscando fechamento: ${codigo}`
    );

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
  }
);

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
  const { jogos } = req.body;
  const usuario_id = req.usuario.id;

  if (!jogos || !Array.isArray(jogos) || jogos.length === 0) {
    return res.status(400).json({ error: "Jogos inválidos." });
  }

  const MAX_JOGOS = 100;
  if (jogos.length > MAX_JOGOS) {
    return res.status(400).json({
      error: `Máximo de ${MAX_JOGOS} jogos por vez.`,
      enviados: jogos.length,
    });
  }

  console.log(`✅ Salvando ${jogos.length} jogos...`);

  const query = `
    INSERT INTO jogos_salvos (dezenas, usuario_id)
    SELECT 
      dezenas_val, $2 
    FROM unnest($1::text[]) AS dezenas_val
    RETURNING id; 
  `;

  try {
    const { rows } = await pool.query(query, [jogos, usuario_id]);
    console.log(`✅ ${rows.length} jogos salvos com sucesso!`);

    res.status(201).json({
      success: true,
      message: `${rows.length} jogo(s) salvo(s) com sucesso.`,
      jogosSalvos: rows.length,
    });
  } catch (error) {
    console.error("❌ Erro ao salvar jogos em lote:", error);
    res.status(500).json({ error: "Erro interno ao salvar os jogos." });
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

// Rota de teste (útil para debug)
app.get("/api/test", (req, res) => {
  res.json({
    status: "ok",
    message: "API funcionando!",
    rotas_disponiveis: [
      "POST /api/register",
      "POST /api/login",
      "GET /api/resultados",
      "POST /api/jogos/salvar",
      "POST /api/jogos/salvar-lote",
      "GET /api/jogos/meus-jogos",
      "POST /api/jogos/delete",
      "GET /api/fechamentos/opcoes",
      "GET /api/fechamento/:codigo",
      "POST /api/pagamento/criar-assinatura",
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
  console.log(`   POST /api/jogos/salvar-lote`);
  console.log(`   GET  /api/jogos/meus-jogos`);
  console.log(`   POST /api/jogos/delete`);
  console.log(`   GET  /api/fechamentos/opcoes`);
  console.log(`   GET  /api/fechamento/:codigo`);
});
