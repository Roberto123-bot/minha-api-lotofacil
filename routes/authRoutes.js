const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
// Garante que as variáveis de ambiente (como EMAIL_USER, FRONTEND_URL) sejam carregadas
require("dotenv").config();

// Importa a pool de conexão do index.js.
const { pool } = require("../index");

// ----------------------------------------------------
// Configuração do Transporter (USANDO PORTA 465 PARA ESTABILIDADE)
// ----------------------------------------------------
const transporter = nodemailer.createTransport({
  // Host do Gmail
  host: "smtp.gmail.com",
  // CRÍTICO: Usando porta 465 para SSL implícito (melhor para hospedagens)
  port: 465,
  // CRÍTICO: Deve ser 'true' para porta 465
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // Senha de Aplicação do Google
  },
});
// ----------------------------------------------------

// ==========================================================
// 🚨 ROTA DE TESTE DE EMAIL (Para verificar as credenciais)
// ==========================================================
router.post("/test-email", async (req, res) => {
  const { email } = req.body;

  console.log(`📥 Testando envio de email para: ${email}`);

  try {
    // Verifica se a conexão SMTP está funcionando (útil para detectar falhas de AUTH)
    await transporter.verify();
    console.log(
      "✅ Servidor de email pronto para receber mensagens (verify ok)"
    );

    const info = await transporter.sendMail({
      from: `"Teste API Lotofácil" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "TESTE DE CONEXÃO SMTP - SUCESSO!",
      html: "<p>Este e-mail confirma que suas credenciais e configurações de porta do Nodemailer estão funcionando corretamente.</p>",
    });

    console.log(`✅ Email de teste enviado: ${info.messageId}`);
    res
      .status(200)
      .json({
        message: "Email de teste enviado com sucesso!",
        messageId: info.messageId,
      });
  } catch (error) {
    console.error("❌ ERRO NO TESTE DE EMAIL:", error);
    res.status(500).json({
      message: "ERRO CRÍTICO: Falha na conexão ou autenticação SMTP.",
      detalhes:
        "Verifique 'EMAIL_USER' e 'EMAIL_PASS' (Senha de Aplicação) no seu .env. O erro técnico foi: " +
        error.message,
      erroTecnico: error.message,
    });
  }
});

// ==========================================================
// Rota POST: /api/forgot-password (Passo 2)
// ==========================================================
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  let user;

  try {
    const result = await pool.query(
      "SELECT id FROM usuarios WHERE email = $1",
      [email]
    );
    user = result.rows[0];
  } catch (error) {
    console.error("Erro na busca do usuário:", error.message);
  }

  // Ponto de Segurança: Sempre retorna 200 OK, mesmo que o email não exista.
  if (!user) {
    return res
      .status(200)
      .json({
        message:
          "Se o e-mail estiver registrado, você receberá um link de redefinição.",
      });
  }

  const userId = user.id;
  const token = crypto.randomBytes(20).toString("hex");
  const expiresAt = new Date(Date.now() + 60000 * 15); // 15 minutos

  try {
    // 1. LÓGICA DE SEGURANÇA: Deleta qualquer token existente para este usuário
    await pool.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [
      userId,
    ]);

    // 2. Insere o novo token no Neon
    await pool.query(
      "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [userId, token, expiresAt]
    );

    // 3. Monta e envia o e-mail
    // Garante que a URL base termine com barra
    const frontendUrlBase = process.env.FRONTEND_URL.endsWith("/")
      ? process.env.FRONTEND_URL
      : process.env.FRONTEND_URL + "/";
    const resetLink = `${frontendUrlBase}reset-password.html?token=${token}`;

    await transporter.sendMail({
      from: `"Lotofácil" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Redefinição de Senha - LOTOFACIL",
      html: `
                <p>Você solicitou a redefinição de sua senha.</p>
                <p>Clique no link abaixo para criar uma nova senha:</p>
                <a href="${resetLink}">Redefinir Minha Senha</a>
                <p>Este link expira em 15 minutos.</p>
            `,
    });
    console.log(
      `✅ Email enviado com sucesso para ${email}. Link: ${resetLink}`
    );

    return res
      .status(200)
      .json({
        message:
          "Se o e-mail estiver registrado, você receberá um link de redefinição.",
      });
  } catch (error) {
    console.error(
      "❌ ERRO GRAVE ao processar forgot-password (Nodemailer):",
      error.message
    );
    return res.status(500).json({
      message:
        "Erro no servidor ao enviar o email. O token foi gerado, mas o envio falhou.",
      detalhes: error.message,
    });
  }
});

// ==========================================================
// Rota POST: /api/reset-password (Passo 3)
// ==========================================================
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  // 1. Valida o token e verifica se não expirou
  let tokenRecord;
  try {
    const result = await pool.query(
      "SELECT user_id FROM password_reset_tokens WHERE token = $1 AND expires_at > NOW()",
      [token]
    );
    tokenRecord = result.rows[0];
  } catch (error) {
    return res.status(500).json({ message: "Erro ao buscar token." });
  }

  if (!tokenRecord) {
    return res.status(400).json({ error: "Token inválido ou expirado." });
  }

  const userId = tokenRecord.user_id;

  try {
    // 2. Criptografa a nova senha
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // 3. Atualiza a senha na tabela 'usuarios' (ATENÇÃO: Nome da coluna é 'senha_hash')
    await pool.query("UPDATE usuarios SET senha_hash = $1 WHERE id = $2", [
      hashedPassword,
      userId,
    ]);

    // 4. Limpa o token para evitar reutilização
    await pool.query("DELETE FROM password_reset_tokens WHERE token = $1", [
      token,
    ]);

    return res
      .status(200)
      .json({ message: "Senha redefinida com sucesso. Faça login." });
  } catch (error) {
    console.error("Erro ao redefinir senha:", error.message);
    return res.status(500).json({ message: "Erro interno do servidor." });
  }
});

module.exports = router;
