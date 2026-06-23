const { createClient } = require('@supabase/supabase-js');

// Verifica se as credenciais estão no .env
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    throw new Error("SUPABASE_URL e SUPABASE_KEY não foram encontrados no .env");
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function salvarCadastro(userId, salario, limitesCartoes) {
    const { data, error } = await supabase
        .from('usuarios')
        .upsert({ 
            user_id: userId, 
            salario: salario, 
            limites_cartoes: limitesCartoes, 
            onboarding_completo: 1,
            pontos_finan: 0 // Mantém 0 ou ignora se já existir
        }, { onConflict: 'user_id' });

    if (error) throw new Error(error.message);
    return { sucesso: true };
}

async function obterCadastro(userId) {
    const { data, error } = await supabase
        .from('usuarios')
        .select('*')
        .eq('user_id', userId)
        .eq('onboarding_completo', 1)
        .single();
    
    // single() retorna erro se não achar, então tratamos
    if (error && error.code !== 'PGRST116') {
        throw new Error(error.message);
    }
    return data;
}

async function registrarTransacao(userId, tipo, valor, descricao, data, categoria = 'Geral', estabelecimento = 'Não informado', metodo_pagamento = 'Não informado') {
    // Insere transação
    const { data: insertData, error: insertError } = await supabase
        .from('transacoes')
        .insert([{
            user_id: userId,
            tipo: tipo,
            valor: valor,
            descricao: descricao,
            data: data,
            categoria: categoria,
            estabelecimento: estabelecimento,
            metodo_pagamento: metodo_pagamento
        }])
        .select();

    if (insertError) throw new Error(insertError.message);
    
    // Calcula saldo
    const { data: rows, error: selectError } = await supabase
        .from('transacoes')
        .select('tipo, valor')
        .eq('user_id', userId);

    if (selectError) throw new Error(selectError.message);
    
    let saldo = 0;
    for (let row of rows) {
        if (row.tipo === 'receita') saldo += row.valor;
        else saldo -= row.valor;
    }
    
    return { id: insertData[0].id, sucesso: true, saldo_atual: saldo };
}

async function obterRelatorio(userId) {
    const { data, error } = await supabase
        .from('transacoes')
        .select('*')
        .eq('user_id', userId)
        .order('data', { ascending: false });
        
    if (error) throw new Error(error.message);
    return data;
}

async function obterEstatisticasMes(userId) {
    const hoje = new Date();
    const anoMes = hoje.toISOString().substring(0, 7);
    
    const { data: rows, error } = await supabase
        .from('transacoes')
        .select('tipo, valor, categoria')
        .eq('user_id', userId)
        .like('data', `${anoMes}%`);

    if (error) throw new Error(error.message);

    let receitas = 0;
    let despesas = 0;
    let gastosPorCategoria = {};
    
    for (let row of rows) {
        if (row.tipo === 'receita') receitas += row.valor;
        else {
            despesas += row.valor;
            gastosPorCategoria[row.categoria] = (gastosPorCategoria[row.categoria] || 0) + row.valor;
        }
    }
    return { receitas, despesas, gastosPorCategoria, saldo: receitas - despesas };
}

async function obterResumoDoDia() {
    const hojeLocal = new Date().toLocaleDateString('en-CA');
    const { data: rows, error } = await supabase
        .from('transacoes')
        .select('*')
        .eq('data', hojeLocal);

    if (error) throw new Error(error.message);

    const resumoPorUsuario = {};
    for (let row of rows) {
        if (!resumoPorUsuario[row.user_id]) {
            resumoPorUsuario[row.user_id] = { receitas: 0, despesas: 0, transacoes: [] };
        }
        if (row.tipo === 'receita') resumoPorUsuario[row.user_id].receitas += row.valor;
        else resumoPorUsuario[row.user_id].despesas += row.valor;
        resumoPorUsuario[row.user_id].transacoes.push(row);
    }
    return resumoPorUsuario;
}

async function limparDados(userId) {
    // Apaga transacoes
    const { error: err1 } = await supabase.from('transacoes').delete().eq('user_id', userId);
    if (err1) throw new Error(err1.message);
    
    // Apaga usuarios
    const { error: err2 } = await supabase.from('usuarios').delete().eq('user_id', userId);
    if (err2) throw new Error(err2.message);
    
    // Apaga metas
    const { error: err3 } = await supabase.from('metas').delete().eq('user_id', userId);
    if (err3) throw new Error(err3.message);
    
    // Apaga dividas
    const { error: err4 } = await supabase.from('dividas').delete().eq('user_id', userId);
    if (err4) throw new Error(err4.message);

    return { sucesso: true, removidos: -1 }; // Contagem omitida por limite da api REST
}

async function gerenciarMeta(userId, acao, nome, valorAlvo = 0, valorInvestido = 0) {
    if (acao === 'criar') {
        const { data, error } = await supabase
            .from('metas')
            .insert([{ user_id: userId, nome: nome, valor_alvo: valorAlvo, valor_atual: 0 }])
            .select();
        if (error) throw new Error(error.message);
        return { sucesso: true, meta_id: data[0].id, mensagem: `Meta '${nome}' criada com sucesso!` };
        
    } else if (acao === 'investir') {
        const { data: meta, error: getError } = await supabase
            .from('metas')
            .select('*')
            .eq('user_id', userId)
            .eq('nome', nome)
            .single();
            
        if (getError) throw new Error(getError.message);
        if (!meta) return { sucesso: false, erro: "Meta não encontrada." };
        
        const novoValor = meta.valor_atual + valorInvestido;
        const { error: updateError } = await supabase
            .from('metas')
            .update({ valor_atual: novoValor })
            .eq('id', meta.id);
            
        if (updateError) throw new Error(updateError.message);
        return { sucesso: true, nome: meta.nome, valor_alvo: meta.valor_alvo, valor_atual: novoValor };
        
    } else if (acao === 'listar') {
        const { data, error } = await supabase
            .from('metas')
            .select('*')
            .eq('user_id', userId);
        if (error) throw new Error(error.message);
        return { sucesso: true, metas: data };
    }
}

async function gerenciarDivida(userId, acao, nome, valorTotal = 0, valorPago = 0) {
    if (acao === 'criar') {
        const { data, error } = await supabase
            .from('dividas')
            .insert([{ user_id: userId, nome: nome, valor_total: valorTotal, valor_pago: valorPago }])
            .select();
        if (error) throw new Error(error.message);
        return { sucesso: true, divida_id: data[0].id, mensagem: `Dívida '${nome}' registrada com sucesso!` };
    } else if (acao === 'listar') {
        const { data, error } = await supabase
            .from('dividas')
            .select('*')
            .eq('user_id', userId);
        if (error) throw new Error(error.message);
        return { sucesso: true, dividas: data };
    }
}

async function adicionarPontos(userId, pontos) {
    const { data: user, error: getError } = await supabase
        .from('usuarios')
        .select('pontos_finan')
        .eq('user_id', userId)
        .single();
        
    if (getError) throw new Error(getError.message);
    if (!user) return { sucesso: false, erro: "Usuário não encontrado." };
    
    const novosPontos = (user.pontos_finan || 0) + pontos;
    const { error: updateError } = await supabase
        .from('usuarios')
        .update({ pontos_finan: novosPontos })
        .eq('user_id', userId);
        
    if (updateError) throw new Error(updateError.message);
    return { sucesso: true, pontos_ganhos: pontos, total_pontos: novosPontos };
}

async function diagnosticoCompleto(userId) {
    try {
        const cadastro = await obterCadastro(userId);
        if (!cadastro) return { erro: "Usuário não possui cadastro." };
        
        const estatisticas = await obterEstatisticasMes(userId);
        
        const { data: metas } = await supabase.from('metas').select('*').eq('user_id', userId);
        const { data: dividas } = await supabase.from('dividas').select('*').eq('user_id', userId);

        return {
            perfil: {
                salario: cadastro.salario,
                pontos_finan: cadastro.pontos_finan,
                limites_cartoes: cadastro.limites_cartoes
            },
            mes_atual: estatisticas,
            metas: metas || [],
            dividas: dividas || []
        };
    } catch (e) {
        return { erro: e.message };
    }
}

module.exports = {
    registrarTransacao,
    obterRelatorio,
    limparDados,
    obterEstatisticasMes,
    obterResumoDoDia,
    salvarCadastro,
    obterCadastro,
    gerenciarMeta,
    gerenciarDivida,
    adicionarPontos,
    diagnosticoCompleto
};
