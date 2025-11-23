// routes/authRoutes.js

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const crypto = require("crypto"); // Para gerar tokens seguros
const { pool } = require("../index"); // Importa a pool do index.js

// CONFIGURAÇÃO DO EMAIL (Você precisará de uma biblioteca como 'nodemailer')
// const nodemailer = require('nodemailer');
// const transporter = nodemailer.createTransport({...});
// *******************************************************************

// Rota POST: /api/forgot-password (Passo 2)
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  // 1. Busca o usuário
  let user;
  try {
    const result = await pool.query(
      "SELECT id FROM usuarios WHERE email = $1",
      [email]
    );
    user = result.rows[0];
  } catch (error) {
    console.error("Erro na busca do usuário:", error);
    // Não revele erros internos
  }

  // Ponto de Segurança: Não informa se o email existe ou não
  if (!user) {
    return res.status(200).json({
      message:
        "Se o e-mail estiver registrado, você receberá um link de redefinição.",
    });
  }

  const userId = user.id;
  const token = crypto.randomBytes(20).toString("hex"); // Gera um token aleatório e seguro
  const expiresAt = new Date(Date.now() + 60000 * 15); // Expira em 15 minutos

  try {
    // 2. Insere o token na tabela password_reset_tokens
    await pool.query(
      "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [userId, token, expiresAt]
    );

    // 3. ENVIAR EMAIL: (Substitua esta lógica pela sua implementação de envio de email)
    const resetLink = `https://projeto-lotofacil-api.vercel.app/reset-password?token=${token}`;
    console.log(`Link de Redefinição Gerado: ${resetLink}`);

    // Exemplo simulado de envio de email:
    /* await transporter.sendMail({
            to: email,
            subject: 'Redefinição de Senha',
            text: `Clique aqui para redefinir: ${resetLink}`,
        });
        */

    return res.status(200).json({
      message:
        "Se o e-mail estiver registrado, você receberá um link de redefinição.",
    });
  } catch (error) {
    console.error("Erro ao gerar token e enviar email:", error);
    return res.status(500).json({ message: "Erro interno do servidor." });
  }
});

// Rota POST: /api/reset-password (Passo 3)
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
    return res.status(400).json({ message: "Token inválido ou expirado." });
  }

  const userId = tokenRecord.user_id;

  try {
    // 2. Criptografa a nova senha
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // 3. Atualiza a senha na tabela 'usuarios'
    await pool.query("UPDATE usuarios SET senha = $1 WHERE id = $2", [
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
    console.error("Erro ao redefinir senha:", error);
    return res.status(500).json({ message: "Erro interno do servidor." });
  }
});

module.exports = router;
