import { Router } from "express";

// RF004 — recebe o pedido do cliente e registra no banco.
// Os preços NUNCA vêm do navegador: são lidos do banco aqui.

class ErroValidacao extends Error {}

const emCentavos = (valor) => Math.round(Number(valor) * 100);
const textoOpcional = (valor, max) =>
  typeof valor === "string" && valor.trim() ? valor.trim().slice(0, max) : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function pedidosRoutes(supabase) {
  const router = Router();

  router.post("/pedidos", async (req, res) => {
    try {
      const pedido = validarEntrada(req.body);
      const itensCalculados = await calcularItens(supabase, pedido.itens);
      const total = itensCalculados.reduce((soma, i) => soma + i.subtotalCentavos, 0);

      const resultado = await gravarPedido(supabase, pedido, itensCalculados, total);
      res.status(201).json(resultado);
    } catch (erro) {
      if (erro instanceof ErroValidacao) {
        return res.status(400).json({ erro: erro.message });
      }
      console.error("Erro ao criar pedido:", erro);
      res.status(500).json({ erro: "Não foi possível registrar o pedido. Tente novamente." });
    }
  });

  // GET /api/pedidos/:id/status → público, usado pela tela do cliente para
  // acompanhar o preparo (RF008). Não expõe nome, mesa nem itens; o pedido
  // completo fica só no painel de administração.
  router.get("/pedidos/:id/status", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ erro: "Número de pedido inválido." });
    }

    const { data, error } = await supabase
      .from("pedidos")
      .select("id, status")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error("Erro ao buscar status do pedido:", error);
      return res.status(500).json({ erro: "Não foi possível buscar o pedido." });
    }
    if (!data) return res.status(404).json({ erro: "Pedido não encontrado." });

    res.json({ numero: data.id, status: data.status });
  });

  // GET /api/comandas/:id → público. O id é um UUID aleatório guardado só no
  // navegador do cliente, então funciona como a "chave" da comanda.
  // Pedidos cancelados aparecem na lista, mas não entram no total.
  router.get("/comandas/:id", async (req, res) => {
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(404).json({ erro: "Comanda não encontrada." });

    const { data, error } = await supabase
      .from("comandas")
      .select(
        `id, nome_cliente, mesa, status, created_at, fechada_em,
         pedidos(id, status, total, created_at,
           itens_pedido(id, nome_produto, quantidade, subtotal, observacao,
             itens_pedido_opcoes(nome_opcao)))`,
      )
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error("Erro ao buscar comanda:", error);
      return res.status(500).json({ erro: "Não foi possível carregar a comanda." });
    }
    if (!data) return res.status(404).json({ erro: "Comanda não encontrada." });

    const pedidos = (data.pedidos ?? [])
      .sort((a, b) => a.id - b.id)
      .map((p) => ({
        numero: p.id,
        status: p.status,
        total: Number(p.total),
        created_at: p.created_at,
        itens: (p.itens_pedido ?? [])
          .sort((a, b) => a.id - b.id)
          .map((i) => ({
            nome: i.nome_produto,
            quantidade: i.quantidade,
            subtotal: Number(i.subtotal),
            observacao: i.observacao,
            opcoes: (i.itens_pedido_opcoes ?? []).map((o) => o.nome_opcao),
          })),
      }));

    res.json({
      id: data.id,
      nome_cliente: data.nome_cliente,
      mesa: data.mesa,
      status: data.status,
      created_at: data.created_at,
      fechada_em: data.fechada_em,
      total: totalDaComanda(pedidos),
      pedidos,
    });
  });

  return router;
}

export function totalDaComanda(pedidos) {
  const centavos = pedidos
    .filter((p) => p.status !== "cancelado")
    .reduce((soma, p) => soma + emCentavos(p.total), 0);
  return centavos / 100;
}

function validarEntrada(body) {
  const { nome_cliente, mesa, observacoes, itens, comanda_id } = body ?? {};

  const nome = typeof nome_cliente === "string" ? nome_cliente.trim() : "";
  if (!nome) throw new ErroValidacao("Informe seu nome.");
  if (nome.length > 80) throw new ErroValidacao("Nome muito longo.");

  let mesaNum = null;
  if (mesa !== undefined && mesa !== null && mesa !== "") {
    mesaNum = Number(mesa);
    if (!Number.isInteger(mesaNum) || mesaNum < 1 || mesaNum > 999) {
      throw new ErroValidacao("Número da mesa inválido.");
    }
  }

  if (!Array.isArray(itens) || itens.length === 0) {
    throw new ErroValidacao("O pedido está vazio.");
  }
  if (itens.length > 50) throw new ErroValidacao("Pedido com itens demais.");

  const itensNorm = itens.map((item) => {
    const produto_id = Number(item?.produto_id);
    const quantidade = Number(item?.quantidade ?? 1);
    const opcoes = Array.isArray(item?.opcoes) ? [...new Set(item.opcoes.map(Number))] : [];

    if (!Number.isInteger(produto_id) || produto_id < 1) {
      throw new ErroValidacao("Produto inválido no pedido.");
    }
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 99) {
      throw new ErroValidacao("Quantidade inválida.");
    }
    if (opcoes.some((id) => !Number.isInteger(id) || id < 1)) {
      throw new ErroValidacao("Opção inválida no pedido.");
    }

    return { produto_id, quantidade, opcoes, observacao: textoOpcional(item?.observacao, 140) };
  });

  return {
    nome_cliente: nome,
    mesa: mesaNum,
    observacoes: textoOpcional(observacoes, 300),
    itens: itensNorm,
    // Código inválido é ignorado: o pedido só abre uma comanda nova
    comanda_id: typeof comanda_id === "string" && UUID.test(comanda_id) ? comanda_id : null,
  };
}

// Usa a comanda que o navegador mandou, se ela ainda estiver aberta.
// Senão (primeiro pedido, comanda já paga ou código desconhecido) abre uma nova.
async function obterComanda(supabase, pedido) {
  if (pedido.comanda_id) {
    const { data, error } = await supabase
      .from("comandas")
      .select("id, status")
      .eq("id", pedido.comanda_id)
      .maybeSingle();
    if (error) throw error;
    if (data?.status === "aberta") return { id: data.id, nova: false };
  }

  const { data: nova, error } = await supabase
    .from("comandas")
    .insert({ nome_cliente: pedido.nome_cliente, mesa: pedido.mesa })
    .select("id")
    .single();
  if (error) throw error;
  return { id: nova.id, nova: true };
}

async function calcularItens(supabase, itens) {
  const ids = [...new Set(itens.map((i) => i.produto_id))];

  const { data: produtos, error } = await supabase
    .from("produtos")
    .select(
      `id, nome, preco, disponivel,
       produto_grupos(grupos_opcoes(id, nome, min_escolhas, max_escolhas,
         opcoes(id, nome, preco_adicional, disponivel)))`,
    )
    .in("id", ids);

  if (error) throw error;

  const porId = new Map(produtos.map((p) => [p.id, p]));

  return itens.map((item) => {
    const produto = porId.get(item.produto_id);
    if (!produto || !produto.disponivel || produto.preco === null) {
      throw new ErroValidacao(
        produto ? `${produto.nome} não está disponível no momento.` : "Um dos produtos não existe mais.",
      );
    }

    const grupos = (produto.produto_grupos ?? []).map((pg) => pg.grupos_opcoes).filter(Boolean);

    // opção → grupo, apenas das opções que este produto oferece
    const opcoesValidas = new Map();
    for (const g of grupos) {
      for (const o of g.opcoes ?? []) {
        if (o.disponivel) opcoesValidas.set(o.id, { ...o, grupo_id: g.id });
      }
    }

    const escolhidas = item.opcoes.map((id) => {
      const opcao = opcoesValidas.get(id);
      if (!opcao) throw new ErroValidacao(`Opção indisponível para ${produto.nome}.`);
      return opcao;
    });

    for (const g of grupos) {
      const qtd = escolhidas.filter((o) => o.grupo_id === g.id).length;
      if (qtd < g.min_escolhas) {
        throw new ErroValidacao(`Escolha "${g.nome}" para ${produto.nome}.`);
      }
      if (g.max_escolhas !== null && qtd > g.max_escolhas) {
        throw new ErroValidacao(`Opções demais em "${g.nome}" para ${produto.nome}.`);
      }
    }

    const unitarioCentavos =
      emCentavos(produto.preco) +
      escolhidas.reduce((soma, o) => soma + emCentavos(o.preco_adicional), 0);

    return {
      produto,
      quantidade: item.quantidade,
      observacao: item.observacao,
      escolhidas,
      subtotalCentavos: unitarioCentavos * item.quantidade,
    };
  });
}

async function gravarPedido(supabase, pedido, itens, totalCentavos) {
  const comanda = await obterComanda(supabase, pedido);
  const desfazerComanda = async () => {
    if (comanda.nova) await supabase.from("comandas").delete().eq("id", comanda.id);
  };

  const { data: novo, error: erroPedido } = await supabase
    .from("pedidos")
    .insert({
      comanda_id: comanda.id,
      nome_cliente: pedido.nome_cliente,
      mesa: pedido.mesa,
      observacoes: pedido.observacoes,
      total: totalCentavos / 100,
    })
    .select("id, status, total")
    .single();

  if (erroPedido) {
    await desfazerComanda();
    throw erroPedido;
  }

  try {
    for (const item of itens) {
      const { data: itemCriado, error: erroItem } = await supabase
        .from("itens_pedido")
        .insert({
          pedido_id: novo.id,
          produto_id: item.produto.id,
          nome_produto: item.produto.nome,
          preco_unitario: item.produto.preco,
          quantidade: item.quantidade,
          observacao: item.observacao,
          subtotal: item.subtotalCentavos / 100,
        })
        .select("id")
        .single();

      if (erroItem) throw erroItem;

      if (item.escolhidas.length) {
        const { error: erroOpcoes } = await supabase.from("itens_pedido_opcoes").insert(
          item.escolhidas.map((o) => ({
            item_pedido_id: itemCriado.id,
            opcao_id: o.id,
            nome_opcao: o.nome,
            preco_adicional: o.preco_adicional,
          })),
        );
        if (erroOpcoes) throw erroOpcoes;
      }
    }
  } catch (erro) {
    // Sem transação no supabase-js: desfaz o pedido incompleto (itens caem em cascata)
    await supabase.from("pedidos").delete().eq("id", novo.id);
    await desfazerComanda();
    throw erro;
  }

  // Primeiro registro do histórico (RF008). Feito pelo cliente, então sem usuário.
  const { error: erroHistorico } = await supabase
    .from("historico_status")
    .insert({ pedido_id: novo.id, status_anterior: null, status_novo: novo.status });
  if (erroHistorico) console.error("Falha ao registrar histórico inicial:", erroHistorico);

  return { numero: novo.id, total: Number(novo.total), status: novo.status, comanda_id: comanda.id };
}
