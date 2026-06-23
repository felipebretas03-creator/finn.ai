require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./database');
const cron = require('node-cron');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const ONBOARDING_PROMPT = `Você é o Finan Coach. O usuário acabou de chegar e AINDA NÃO TEM CADASTRO.
Seu objetivo AGORA é fazer uma entrevista super rápida e amigável para descobrir as finanças básicas dele.
Pergunte:
1. Qual o salário/renda mensal dele.
2. Quais cartões de crédito ele usa e qual o limite aproximado de cada um.

Não peça tudo de uma vez. Faça de forma conversacional.
Assim que você tiver recolhido o salário numérico e os limites dos cartões através da conversa, chame a ferramenta 'finalizar_cadastro' com esses dados para criar o perfil dele.
MUITO IMPORTANTE: Logo após chamar a ferramenta de finalizar o cadastro, mande uma mensagem de parabéns ao usuário e adicione esta instrução no final da sua fala: "Sempre que tiver alguma dúvida ou quiser ver todas as minhas funcionalidades, basta digitar /ajuda!"`;

function getCoachPrompt(perfil) {
    return `Você é o Finan Coach, um treinador financeiro gamificado e inteligente.

PERFIL DO USUÁRIO:
Salário Mensal: R$ ${perfil.salario}
Limites de Cartões: ${perfil.limites_cartoes}
Pontos Finan Atuais: ${perfil.pontos_finan}

REGRAS E COMPORTAMENTOS:
1. TRANSAÇÕES: Ao registrar um gasto (use 'registrar_transacao'), responda em 2 blocos (separados por \\n\\n). Confirme visualmente e dê a perspectiva do impacto % no salário.
2. METAS E BARRAS DE PROGRESSO: Ao consultar, investir ou criar metas (use 'gerenciar_meta'), SEMPRE desenhe a barra de progresso gamificada na resposta!
   Exemplo de formato obrigatório para metas:
   🎯 [Nome da Meta]
   ██████░░░░ [XX]%
   R$ [Atual] de R$ [Alvo]
   (A barra de progresso deve ter sempre 10 caracteres no total: 1 █ para cada 10%).
3. DÍVIDAS: Quando o usuário mencionar dívidas, use 'gerenciar_divida' para salvar. Ofereça conselhos de quitação prioritária.
4. DESAFIOS E PONTOS: Seja proativo! Analise os gastos e, às vezes, lance "💰 Desafio da Semana" (ex: gastar menos no delivery em troca de +15 Pontos Finan). Se o usuário disser que cumpriu um desafio ou você quiser recompensá-lo por algo bom, use a ferramenta 'adicionar_pontos' e comemore efusivamente!
5. SAÚDE FINANCEIRA E PERFIL: Se o usuário perguntar seu "Perfil", sua "Nota" ou "Saúde Financeira", use 'diagnostico_completo'. Leia a resposta crua do banco, e com sua inteligência crie um "❤️ Saúde Financeira (ex: 82/100)" com base no balanço dele, e defina o Perfil Psicológico dele (Ex: Conservador, Equilibrado, Impulsivo) justificando o porquê.`;
}

const tools = [
  {
    type: "function",
    function: {
      name: "finalizar_cadastro",
      description: "Salva o cadastro inicial do usuário (onboarding).",
      parameters: {
        type: "object",
        properties: {
          salario: { type: "number" },
          limites_cartoes: { type: "string" }
        },
        required: ["salario", "limites_cartoes"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "registrar_transacao",
      description: "Salva uma transação no banco de dados.",
      parameters: {
        type: "object",
        properties: {
          tipo: { type: "string", description: "'receita' ou 'despesa'" },
          valor: { type: "number" },
          descricao: { type: "string" },
          data: { type: "string", description: "AAAA-MM-DD" },
          categoria: { type: "string" },
          estabelecimento: { type: "string" },
          metodo_pagamento: { type: "string" }
        },
        required: ["tipo", "valor", "descricao", "data", "categoria", "estabelecimento", "metodo_pagamento"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "gerenciar_meta",
      description: "Cria, investe dinheiro ou lista as metas/sonhos do usuário.",
      parameters: {
        type: "object",
        properties: {
          acao: { type: "string", description: "'criar', 'investir' ou 'listar'" },
          nome: { type: "string", description: "Nome da meta (ex: Viagem Nordeste). Obrigatório para criar/investir." },
          valor_alvo: { type: "number", description: "Obrigatório se acao=criar." },
          valor_investido: { type: "number", description: "Obrigatório se acao=investir. Valor que o usuário quer depositar agora na meta." }
        },
        required: ["acao"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "gerenciar_divida",
      description: "Cria ou lista as dívidas do usuário.",
      parameters: {
        type: "object",
        properties: {
          acao: { type: "string", description: "'criar' ou 'listar'" },
          nome: { type: "string" },
          valor_total: { type: "number" },
          valor_pago: { type: "number" }
        },
        required: ["acao"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "adicionar_pontos",
      description: "Adiciona Pontos Finan (gamificação) quando o usuário cumpre um desafio financeiro proposto por você.",
      parameters: {
        type: "object",
        properties: {
          pontos: { type: "number", description: "Quantidade de pontos a dar (ex: 10, 15, 50)" }
        },
        required: ["pontos"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "diagnostico_completo",
      description: "Retorna todos os dados financeiros (salário, gastos do mês, metas, dívidas) para você poder calcular a Saúde Financeira (nota de 0 a 100) e o perfil do usuário.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "gerar_relatorio",
      description: "Obtém o histórico de transações para gerar um relatório completo.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "limpar_dados",
      description: "Apaga todos os dados do usuário, util caso ele peça para recomeçar ou limpar a conta.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "analisar_previsao_caixa",
      description: "Calcula a projeção matemática de gastos para o fim do mês, indicando se o usuário vai fechar no azul ou no vermelho baseado na média diária.",
      parameters: { type: "object", properties: {} }
    }
  }
];

const MENU_AJUDA = `🚀 *Bem-vindo ao Finan Coach!*

Eu sou muito mais que um bloquinho de notas. Sou seu treinador financeiro gamificado com Inteligência Artificial!

Aqui estão as funcionalidades que você pode usar conversando comigo (por texto ou áudio 🎙️):

💸 *1. Registro Inteligente*
Diga: _"Comprei um lanche de 25 reais no McDonald's no cartão Nubank"_ e eu organizo tudo sozinho (categoria, local e cartão).

🎯 *2. Metas Gamificadas*
Diga: _"Quero criar a meta Viagem de R$ 10.000"_ e depois vá me avisando quando juntar dinheiro para ver sua barra de progresso encher!

💳 *3. Controle de Dívidas*
Diga: _"Cadastra uma dívida de 2.000 do empréstimo Itaú"_.

❤️ *4. Saúde Financeira e Perfil*
Pergunte: _"Qual é a minha Saúde Financeira?"_ e eu calcularei uma nota de 0 a 100 baseada nos seus hábitos!

🎮 *5. Pontos Finan e Desafios*
Cumpra os desafios que eu propor para ganhar Pontos Finan!

📊 *6. Relatório e Conselhos*
Pergunte: _"Posso comprar um tênis de 300 reais?"_ e eu te darei um conselho real baseado no seu salário cadastrado. 
*(Lembrando: Todos os dias às 20h eu te mando o seu Resumo Diário!)*

🔄 *Como apagar tudo e recomeçar:*
Basta me dizer _"Limpar meus dados"_.

Mande um "Oi" para começarmos a sua entrevista de cadastro!`;

bot.start((ctx) => {
    ctx.replyWithMarkdown(MENU_AJUDA);
});

bot.help((ctx) => {
    ctx.replyWithMarkdown(MENU_AJUDA);
});

const userHistories = {};

async function handleChat(ctx, userId, userText) {
    const perfil = await db.obterCadastro(userId.toString());
    const promptAtivo = perfil ? getCoachPrompt(perfil) : ONBOARDING_PROMPT;

    if (!userHistories[userId]) {
        userHistories[userId] = [{ role: "system", content: promptAtivo }];
    } else {
        userHistories[userId][0] = { role: "system", content: promptAtivo };
    }

    if (userHistories[userId].length > 25) {
        userHistories[userId].splice(1, 4); // Limpa mensagens mais antigas para liberar espaço
    }

    userHistories[userId].push({ role: "user", content: userText });

    try {
        await ctx.sendChatAction('typing');

        let response = await openai.chat.completions.create({
            model: "openai/gpt-4o-mini",
            messages: userHistories[userId],
            tools: tools,
            tool_choice: "auto"
        });

        let responseMessage = response.choices[0].message;

        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            userHistories[userId].push(responseMessage);

            for (const toolCall of responseMessage.tool_calls) {
                const args = JSON.parse(toolCall.function.arguments || '{}');
                let toolResult = {};

                try {
                    if (toolCall.function.name === 'finalizar_cadastro') {
                        await db.salvarCadastro(userId.toString(), args.salario, args.limites_cartoes);
                        toolResult = { sucesso: true, mensagem: "Cadastro concluído." };
                    } else if (toolCall.function.name === 'registrar_transacao') {
                        const res = await db.registrarTransacao(userId.toString(), args.tipo, args.valor, args.descricao, args.data, args.categoria, args.estabelecimento, args.metodo_pagamento);
                        const est = await db.obterEstatisticasMes(userId.toString());
                        toolResult = { sucesso: true, transacao_id: res.id, estatisticas_mes: est };
                        if (res.alerta_meta) {
                            toolResult.alerta_meta = res.alerta_meta;
                        }
                    } else if (toolCall.function.name === 'gerenciar_meta') {
                        toolResult = await db.gerenciarMeta(userId.toString(), args.acao, args.nome, args.valor_alvo, args.valor_investido);
                    } else if (toolCall.function.name === 'gerenciar_divida') {
                        toolResult = await db.gerenciarDivida(userId.toString(), args.acao, args.nome, args.valor_total, args.valor_pago);
                    } else if (toolCall.function.name === 'adicionar_pontos') {
                        toolResult = await db.adicionarPontos(userId.toString(), args.pontos);
                    } else if (toolCall.function.name === 'diagnostico_completo') {
                        toolResult = await db.diagnosticoCompleto(userId.toString());
                    } else if (toolCall.function.name === 'gerar_relatorio') {
                        toolResult = await db.obterRelatorio(userId.toString());
                    } else if (toolCall.function.name === 'limpar_dados') {
                        const res = await db.limparDados(userId.toString());
                        toolResult = { sucesso: true, registros_removidos: res.removidos, instrucao: "Diga que tudo foi apagado." };
                    } else if (toolCall.function.name === 'analisar_previsao_caixa') {
                        toolResult = await db.analisarPrevisaoCaixa(userId.toString());
                    }
                } catch (e) {
                    toolResult = { sucesso: false, erro: e.message };
                }

                userHistories[userId] = userHistories[userId] || [{ role: "system", content: promptAtivo }];
                userHistories[userId].push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: toolCall.function.name,
                    content: JSON.stringify(toolResult)
                });
            }

            response = await openai.chat.completions.create({
                model: "openai/gpt-4o-mini",
                messages: userHistories[userId],
                tools: tools
            });

            responseMessage = response.choices[0].message;
        }

        const responseText = responseMessage.content || "";
        userHistories[userId] = userHistories[userId] || [{ role: "system", content: promptAtivo }];
        
        if (responseText.trim().length > 0) {
            userHistories[userId].push({ role: "assistant", content: responseText });
            const mensagens = responseText.split('\n\n').filter(m => m.trim().length > 0);
            for (const msg of mensagens) {
                await ctx.reply(msg.trim());
            }
        }
    } catch (error) {
        console.error("Erro no bot:", error.message || error);
        if (error.response) {
            console.error("Detalhes do erro:", JSON.stringify(error.response.data, null, 2));
        }
        ctx.reply("Desculpe, tive um probleminha técnico no momento. Pode tentar novamente em alguns segundos?");
    }
}

bot.on('text', async (ctx) => {
    try {
        console.log("MENSAGEM RECEBIDA DO TELEGRAM: ", ctx.message.text);
        if (ctx.message.text && ctx.message.text.startsWith('/')) return;
        const userId = ctx.from.id;
        const userMessage = ctx.message.text;
        await handleChat(ctx, userId, userMessage);
    } catch (e) {
        console.error(e);
    }
});

bot.on('voice', async (ctx) => {
    const userId = ctx.from.id;
    try {
        await ctx.sendChatAction('typing');
        const fileId = ctx.message.voice.file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const response = await fetch(fileLink.href);
        const arrayBuffer = await response.arrayBuffer();
        const base64Data = Buffer.from(arrayBuffer).toString('base64');
        const audioPart = { inlineData: { data: base64Data, mimeType: ctx.message.voice.mime_type || 'audio/ogg' } };

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent([
            "Transcreva o que está sendo dito no áudio. Apenas a transcrição, sem comentários.", 
            audioPart
        ]);
        
        await handleChat(ctx, userId, result.response.text());
    } catch (error) {
        console.error("Erro ao processar áudio:", error.message || error);
        ctx.reply("Desculpe, a fila de áudio está cheia no momento. Pode tentar mandar por texto?");
    }
});

bot.on('photo', async (ctx) => {
    const userId = ctx.from.id;
    try {
        await ctx.reply("📸 Analisando a sua nota fiscal... Aguarde um segundo!");
        await ctx.sendChatAction('typing');
        
        // Pega a foto de maior resolução enviada
        const photos = ctx.message.photo;
        const highestResPhoto = photos[photos.length - 1];
        const fileId = highestResPhoto.file_id;
        
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const response = await fetch(fileLink.href);
        const arrayBuffer = await response.arrayBuffer();
        const base64Data = Buffer.from(arrayBuffer).toString('base64');
        
        const imagePart = { inlineData: { data: base64Data, mimeType: 'image/jpeg' } };

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const userName = ctx.from.first_name + (ctx.from.last_name ? " " + ctx.from.last_name : "");
        const legenda = ctx.message.caption ? `O usuário também enviou este texto junto: "${ctx.message.caption}".\n` : "";
        
        const prompt = `Você é um leitor de comprovantes. 
O nome do dono da conta é "${userName}". 
${legenda}
Analise a imagem e determine:
1. É uma RECEITA (dinheiro recebido) ou DESPESA (dinheiro pago)? Dica: Se o 'Recebedor', 'Destinatário' ou 'Favorecido' for o próprio ${userName}, é uma RECEITA.
2. Qual o valor exato?
3. Quem é a outra parte (quem pagou ou quem recebeu)?

Retorne APENAS uma frase neste formato (sem aspas ou formatação):
"Comprovante de [RECEITA ou DESPESA] no valor de R$ [valor] envolvendo [nome da outra parte]"`;

        const result = await model.generateContent([prompt, imagePart]);
        const textoExtraido = result.response.text().trim();
        
        await ctx.reply(`🔍 Eu entendi isso do recibo:\n_"${textoExtraido}"_\n\nRegistrando automaticamente para você...`);
        
        // Passa a frase extraída para o cérebro principal do bot (GPT) fazer o registro e gamificação
        await handleChat(ctx, userId, textoExtraido);
    } catch (error) {
        console.error("Erro ao processar imagem:", error.message || error);
        ctx.reply("Puxa, não consegui ler muito bem essa imagem. Pode tentar digitar o valor para mim?");
    }
});

cron.schedule('0 20 * * *', async () => {
    console.log("Executando o Resumo Diário...");
    try {
        const resumo = await db.obterResumoDoDia();
        for (const userId in resumo) {
            const r = resumo[userId];
            if (r.transacoes.length === 0) continue;

            let maiorGasto = null;
            for (let t of r.transacoes) {
                if (t.tipo === 'despesa') {
                    if (!maiorGasto || t.valor > maiorGasto.valor) maiorGasto = t;
                }
            }

            const estatisticas = await db.obterEstatisticasMes(userId);
            let msg = `📊 *Resumo de Hoje*\n\n`;
            msg += `Receitas: R$ ${r.receitas.toFixed(2)}\n`;
            msg += `Despesas: R$ ${r.despesas.toFixed(2)}\n\n`;
            
            if (maiorGasto) {
                msg += `Maior gasto:\n`;
                msg += `▪️ ${maiorGasto.estabelecimento} (${maiorGasto.categoria}): R$ ${maiorGasto.valor.toFixed(2)}\n\n`;
            }

            msg += `Saldo atual do mês:\n`;
            msg += `R$ ${estatisticas.saldo.toFixed(2)}`;

            await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        console.error("Erro no resumo diário:", e);
    }
});

bot.launch().then(() => {
    console.log("🤖 Finan Coach Fase 2 Gamificada Ativo!");
}).catch((err) => {
    console.error("Falha ao iniciar o bot:", err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Servidor Web "fantasma" obrigatório para o Render (plano grátis)
const app = express();
app.get('/', (req, res) => {
    res.send('O Bot está rodando perfeitamente!');
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor Web rodando na porta ${PORT}`);
});
