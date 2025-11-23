const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");

// IMPORTANTE: Ajuste o caminho conforme seu arquivo principal
// Se é index.js, use: require("../index")
// Se é server.js, use: require("../server")
let pool;
try {
  pool = require("../server").pool;
} catch (err) {
  pool = require("../index").pool;
}

// ===================================
// === CONFIGURAÇÃO DO NODEMAILER
// ===================================
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || "smtp.gmail.com",
  port: parseInt(process.env.EMAIL_PORT) || 587,
  secure: false, // true para 465, false para 587
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false, // Aceita certificados auto-assinados
  },
  connectionTimeout: 10000, // 10 segundos
  greetingTimeout: 10000,
  socketTimeout: 10000,
});

// Verifica configuração do e-mail na inicialização
console.log("📧 Configuração de E-mail:");
console.log("   Host:", process.env.EMAIL_HOST);
console.log("   Port:", process.env.EMAIL_PORT);
console.log("   User:", process.env.EMAIL_USER);
console.log(
  "   Pass:",
  process.env.EMAIL_PASS ? "✅ Configurada" : "❌ Faltando"
);

transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Erro na configuração do e-mail:", error.message);
    console.error("   Código:", error.code);
    console.error("   Detalhes:", error);
  } else {
    console.log("✅ Servidor de e-mail pronto para enviar mensagens");
  }
});

// ===================================
// === ROTA: SOLICITAR REDEFINIÇÃO
// ===================================
router.post("/forgot-password", async (req, res) => {
  console.log("📥 POST /api/forgot-password");

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: "E-mail é obrigatório.",
      });
    }

    // Verifica se o usuário existe
    const userResult = await pool.query(
      "SELECT id, nome, email FROM usuarios WHERE email = $1",
      [email]
    );

    if (userResult.rows.length === 0) {
      // Por segurança, não revela se o e-mail existe ou não
      console.log(`⚠️ E-mail não encontrado: ${email}`);
      return res.status(200).json({
        message:
          "Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.",
      });
    }

    const user = userResult.rows[0];

    // Gera token único e seguro
    const token = crypto.randomBytes(32).toString("hex");
    const expires_at = new Date(Date.now() + 3600000); // 1 hora

    // Salva token no banco
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) 
       DO UPDATE SET token = $2, expires_at = $3`,
      [user.id, token, expires_at]
    );

    // Link de redefinição
    const resetLink = `${
      process.env.FRONTEND_URL || "http://localhost:3001"
    }/reset-password?token=${token}`;

    console.log(`🔗 Link de redefinição gerado: ${resetLink}`);

    // Envia e-mail
    console.log("📤 Tentando enviar e-mail...");
    const mailOptions = {
      from: `"Lotofácil" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "🔐 Redefinição de Senha - Lotofácil",
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                      color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
            .button { display: inline-block; padding: 15px 30px; background-color: #4CAF50; 
                     color: white !important; text-decoration: none; border-radius: 5px; 
                     font-weight: bold; margin: 20px 0; }
            .button:hover { background-color: #45a049; }
            .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; 
                     font-size: 12px; color: #666; text-align: center; }
            .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; 
                      margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎰 Lotofácil</h1>
              <p>Redefinição de Senha</p>
            </div>
            <div class="content">
              <p>Olá, <strong>${user.nome}</strong>!</p>
              <p>Você solicitou a redefinição de senha da sua conta.</p>
              <p>Clique no botão abaixo para criar uma nova senha:</p>
              
              <center>
                <a href="${resetLink}" class="button">🔓 Redefinir Senha</a>
              </center>
              
              <div class="warning">
                <strong>⏰ Atenção:</strong> Este link é válido por <strong>1 hora</strong>.
              </div>
              
              <p style="color: #666; font-size: 14px;">
                Se você não solicitou esta redefinição, ignore este e-mail. 
                Sua senha permanecerá inalterada.
              </p>
              
              <div class="footer">
                <p>Se o botão não funcionar, copie e cole este link no navegador:</p>
                <p style="word-break: break-all; color: #667eea;">${resetLink}</p>
                <p style="margin-top: 20px;">© ${new Date().getFullYear()} Lotofácil - Todos os direitos reservados</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ E-mail de redefinição enviado para: ${email}`);

    res.status(200).json({
      message:
        "E-mail de redefinição enviado com sucesso! Verifique sua caixa de entrada.",
    });
  } catch (error) {
    console.error("❌ Erro ao processar forgot-password:", error);
    console.error("   Stack:", error.stack);
    console.error("   Code:", error.code);
    console.error("   Response:", error.response);

    // Mensagem de erro mais específica para debug
    let errorMessage = "Erro ao processar solicitação.";
    let detalhesErro = error.message;

    if (error.code === "EAUTH") {
      errorMessage =
        "Erro de autenticação do e-mail. Verifique EMAIL_USER e EMAIL_PASS.";
      detalhesErro =
        "Credenciais do Gmail inválidas. Certifique-se de usar uma senha de app.";
    } else if (error.code === "ECONNECTION") {
      errorMessage = "Erro de conexão com servidor de e-mail.";
    } else if (error.code === "ETIMEDOUT") {
      errorMessage = "Tempo esgotado ao conectar com servidor de e-mail.";
    }

    res.status(500).json({
      error: errorMessage,
      detalhes: detalhesErro,
    });
  }
});

// ===================================
// === ROTA: REDEFINIR SENHA
// ===================================
router.post("/reset-password", async (req, res) => {
  console.log("📥 POST /api/reset-password");

  try {
    const { token, novaSenha } = req.body;

    if (!token || !novaSenha) {
      return res.status(400).json({
        error: "Token e nova senha são obrigatórios.",
      });
    }

    if (novaSenha.length < 6) {
      return res.status(400).json({
        error: "A senha deve ter no mínimo 6 caracteres.",
      });
    }

    // Busca token válido
    const resetResult = await pool.query(
      `SELECT pr.*, u.email, u.nome 
       FROM password_reset_tokens pr
       JOIN usuarios u ON pr.user_id = u.id
       WHERE pr.token = $1 AND pr.expires_at > NOW()`,
      [token]
    );

    if (resetResult.rows.length === 0) {
      console.log(`❌ Token inválido ou expirado: ${token}`);
      return res.status(400).json({
        error:
          "Token inválido ou expirado. Solicite um novo link de redefinição.",
      });
    }

    const reset = resetResult.rows[0];

    // Criptografa nova senha
    const salt = await bcrypt.genSalt(10);
    const senha_hash = await bcrypt.hash(novaSenha, salt);

    // Atualiza senha no banco
    await pool.query("UPDATE usuarios SET senha_hash = $1 WHERE id = $2", [
      senha_hash,
      reset.user_id,
    ]);

    // Remove token usado (evita reutilização)
    await pool.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [
      reset.user_id,
    ]);

    console.log(`✅ Senha redefinida com sucesso para: ${reset.email}`);

    // Envia e-mail de confirmação
    try {
      await transporter.sendMail({
        from: `"Lotofácil" <${process.env.EMAIL_USER}>`,
        to: reset.email,
        subject: "✅ Senha Redefinida com Sucesso",
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%); 
                        color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
              .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>✅ Senha Alterada!</h1>
              </div>
              <div class="content">
                <p>Olá, <strong>${reset.nome}</strong>!</p>
                <p>Sua senha foi redefinida com sucesso.</p>
                <p>Se você não realizou esta alteração, entre em contato imediatamente.</p>
                <p style="margin-top: 30px; color: #666;">
                  Data: ${new Date().toLocaleString("pt-BR")}
                </p>
              </div>
            </div>
          </body>
          </html>
        `,
      });
    } catch (emailError) {
      console.error(
        "⚠️ Erro ao enviar e-mail de confirmação:",
        emailError.message
      );
      // Não falha a requisição por causa do e-mail de confirmação
    }

    res.status(200).json({
      message:
        "Senha redefinida com sucesso! Você já pode fazer login com a nova senha.",
    });
  } catch (error) {
    console.error("❌ Erro ao redefinir senha:", error);
    res.status(500).json({
      error: "Erro ao redefinir senha. Tente novamente.",
      detalhes:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

module.exports = router;
