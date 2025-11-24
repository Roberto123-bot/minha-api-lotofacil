const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Resend } = require("resend");

// Carrega a pool de conexão
let pool;
try {
  pool = require("../index").pool;
} catch (err) {
  try {
    pool = require("../server").pool;
  } catch (err2) {
    console.error("❌ Erro ao importar pool do banco de dados");
  }
}

// ===================================
// === CONFIGURAÇÃO DO RESEND
// ===================================
const resendApiKey = process.env.RESEND_API_KEY;
const resend = new Resend(resendApiKey);

// Logs de configuração
console.log("\n📧 ===== CONFIGURAÇÃO DE E-MAIL =====");
console.log(
  "   Serviço:",
  resendApiKey ? "Resend API ✅" : "Não Configurado ❌"
);
console.log(
  "   API Key:",
  resendApiKey ? `${resendApiKey.substring(0, 10)}...` : "FALTANDO"
);
console.log(
  "   From Email:",
  process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev"
);
console.log("   Frontend URL:", process.env.FRONTEND_URL || "NÃO CONFIGURADA");
console.log("========================================\n");

// ===================================
// === ROTA: SOLICITAR REDEFINIÇÃO
// ===================================
router.post("/forgot-password", async (req, res) => {
  console.log("📥 POST /api/forgot-password");

  try {
    const { email } = req.body;

    // Validação de e-mail
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
      console.log(`⚠️ E-mail não encontrado no banco: ${email}`);
      return res.status(200).json({
        message:
          "Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.",
      });
    }

    const user = userResult.rows[0];
    console.log(`✅ Usuário encontrado: ${user.nome} (${user.email})`);

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

    console.log(`✅ Token gerado e salvo no banco`);

    // Link de redefinição
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3001";
    const resetLink = `${frontendUrl}/reset-password?token=${token}`;

    console.log(`🔗 Link de redefinição: ${resetLink}`);

    // Configuração do e-mail
    const fromEmail = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";

    console.log(`📤 Enviando e-mail para: ${email}`);
    console.log(`📤 From: ${fromEmail}`);

    // Envia e-mail via Resend
    const { data, error } = await resend.emails.send({
      from: `Lotofácil <${fromEmail}>`,
      to: [email],
      reply_to: process.env.REPLY_TO_EMAIL || "robertosantosloteria@gmail.com",
      subject: "🔐 Redefinição de Senha - Lotofácil",
      html: `
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: Arial, sans-serif;
              line-height: 1.6;
              color: #333;
              margin: 0;
              padding: 0;
              background-color: #f4f4f4;
            }
            .container {
              max-width: 600px;
              margin: 20px auto;
              background: white;
              border-radius: 10px;
              overflow: hidden;
              box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            }
            .header {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              padding: 40px 20px;
              text-align: center;
            }
            .header h1 {
              margin: 0;
              font-size: 28px;
            }
            .header p {
              margin: 10px 0 0;
              font-size: 16px;
              opacity: 0.9;
            }
            .content {
              padding: 40px 30px;
            }
            .content p {
              margin: 0 0 15px;
              font-size: 16px;
            }
            .button-container {
              text-align: center;
              margin: 30px 0;
            }
            .button {
              display: inline-block;
              padding: 15px 40px;
              background-color: #4CAF50;
              color: white !important;
              text-decoration: none;
              border-radius: 5px;
              font-weight: bold;
              font-size: 16px;
            }
            .button:hover {
              background-color: #45a049;
            }
            .warning {
              background: #fff3cd;
              border-left: 4px solid #ffc107;
              padding: 15px;
              margin: 20px 0;
              border-radius: 4px;
            }
            .warning strong {
              display: block;
              margin-bottom: 5px;
            }
            .footer {
              margin-top: 30px;
              padding-top: 20px;
              border-top: 1px solid #ddd;
              font-size: 13px;
              color: #666;
            }
            .footer p {
              margin: 5px 0;
            }
            .link-box {
              background: #f8f9fa;
              padding: 10px;
              border-radius: 5px;
              word-break: break-all;
              font-size: 12px;
              color: #667eea;
              margin-top: 10px;
            }
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
              
              <div class="button-container">
                <a href="${resetLink}" class="button">🔓 Redefinir Senha</a>
              </div>
              
              <div class="warning">
                <strong>⏰ Atenção:</strong>
                Este link é válido por <strong>1 hora</strong>.
              </div>
              
              <p>Se você não solicitou esta redefinição, ignore este e-mail. Sua senha permanecerá inalterada.</p>
              
              <div class="footer">
                <p><strong>Problemas para acessar o botão?</strong></p>
                <p>Copie e cole este link no seu navegador:</p>
                <div class="link-box">${resetLink}</div>
                <p style="margin-top: 20px;">© ${new Date().getFullYear()} Lotofácil - Todos os direitos reservados</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    // Verifica se houve erro
    if (error) {
      console.error("❌ ERRO NO RESEND:", error);
      throw error;
    }

    console.log(`✅ E-mail enviado com sucesso!`);
    console.log(`   ID do E-mail: ${data?.id || "N/A"}`);

    res.status(200).json({
      message:
        "E-mail de redefinição enviado com sucesso! Verifique sua caixa de entrada (e spam).",
    });
  } catch (error) {
    console.error("❌ Erro ao processar forgot-password:", error);
    console.error("   Tipo:", error.name);
    console.error("   Mensagem:", error.message);

    // Mensagens de erro mais amigáveis
    let errorMessage = "Erro ao processar solicitação.";
    let detalhes = error.message;

    if (error.message?.includes("API key")) {
      errorMessage = "Erro de configuração do serviço de e-mail.";
      detalhes = "RESEND_API_KEY não configurada ou inválida.";
    } else if (error.message?.includes("domain")) {
      errorMessage = "Erro de domínio de e-mail.";
      detalhes = "O domínio do e-mail não está verificado no Resend.";
    }

    res.status(500).json({
      error: errorMessage,
      detalhes: detalhes,
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

    // Validações
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

    console.log(`🔍 Verificando token: ${token.substring(0, 10)}...`);

    // Busca token válido
    const resetResult = await pool.query(
      `SELECT pr.*, u.email, u.nome 
       FROM password_reset_tokens pr
       JOIN usuarios u ON pr.user_id = u.id
       WHERE pr.token = $1 AND pr.expires_at > NOW()`,
      [token]
    );

    if (resetResult.rows.length === 0) {
      console.log(`❌ Token inválido ou expirado`);
      return res.status(400).json({
        error:
          "Token inválido ou expirado. Solicite um novo link de redefinição.",
      });
    }

    const reset = resetResult.rows[0];
    console.log(`✅ Token válido para usuário: ${reset.email}`);

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

    // Envia e-mail de confirmação (opcional, não bloqueia se falhar)
    try {
      const fromEmail =
        process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";

      await resend.emails.send({
        from: `Lotofácil <${fromEmail}>`,
        to: [reset.email],
        reply_to:
          process.env.REPLY_TO_EMAIL || "robertosantosloteria@gmail.com",
        subject: "✅ Senha Redefinida com Sucesso",
        html: `
          <!DOCTYPE html>
          <html lang="pt-BR">
          <head>
            <meta charset="UTF-8">
            <style>
              body { font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
              .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
              .header { background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%); color: white; padding: 40px 20px; text-align: center; }
              .header h1 { margin: 0; font-size: 28px; }
              .content { padding: 40px 30px; }
              .content p { margin: 0 0 15px; font-size: 16px; }
              .info-box { background: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0; }
              .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 13px; color: #666; }
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
                
                <div class="info-box">
                  <strong>📅 Data e hora:</strong><br>
                  ${new Date().toLocaleString("pt-BR", {
                    dateStyle: "full",
                    timeStyle: "short",
                  })}
                </div>
                
                <p>Se você não realizou esta alteração, entre em contato imediatamente respondendo este e-mail.</p>
                
                <div class="footer">
                  <p>© ${new Date().getFullYear()} Lotofácil - Todos os direitos reservados</p>
                </div>
              </div>
            </div>
          </body>
          </html>
        `,
      });

      console.log(`✅ E-mail de confirmação enviado`);
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
      detalhes: error.message,
    });
  }
});

module.exports = router;
