import { Router } from "express";
import { randomUUID } from "node:crypto";
import { avisarCardapioAlterado } from "../eventos.js";
import { totalDaComanda } from "./pedidos.js";

// Módulo de administração — RF005 a RF008
// Login pelo Supabase Auth (JWT). Toda rota, exceto /login, exige um
// token válido de um usuário presente e ativo na tabela administradores.

const BUCKET = "produtos";
const TIPOS_IMAGEM = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const LIMITE_IMAGEM = 5 * 1024 * 1024;
const STATUS_ADMIN = ["recebido", "em_preparo", "pronto", "entregue"];

class ErroValidacao extends Error {}

export default function adminRoutes(supabase, criarClienteAuth) {
  const router = Router();

  // -------------------------------------------------------------------
  // RF005 — Login
  // -------------------------------------------------------------------
  router.post("/login", async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const senha = typeof req.body?.senha === "string" ? req.body.senha : "";

    if (!email || !senha) {
      return res.status(400).json({ erro: "Informe e-mail e senha." });
    }

    // Cliente separado: o login não pode "grudar" sessão no cliente do servidor
    const auth = criarClienteAuth();
    const { data, error } = await auth.auth.signInWithPassword({ email, password: senha });

    if (error || !data?.session) {
      return res.status(401).json({ erro: "E-mail ou senha incorretos." });
    }

    const admin = await buscarAdmin(supabase, data.user.id);
    if (!admin) {
      return res.status(403).json({ erro: "Esta conta não tem acesso ao painel." });
    }

    res.json({
      access_token: data.session.access_token,
      expires_at: data.session.expires_at, // segundos (epoch)
      admin: { nome: admin.nome, email: admin.email },
    });
  });

  // Daqui para baixo, só com token válido
  router.use(exigirAdmin(supabase));

  router.get("/me", (req, res) => {
    res.json({ nome: req.admin.nome, email: req.admin.email });
  });

  // -------------------------------------------------------------------
  // RF006 — Itens do cardápio
  // -------------------------------------------------------------------
  router.get("/categorias", async (req, res) => {
    const { data, error } = await supabase
      .from("categorias")
      .select("id, slug, nome, ordem")
      .order("ordem");
    if (error) return falha(res, error, "Não foi possível carregar as categorias.");
    res.json(data);
  });

  router.get("/produtos", async (req, res) => {
    const { data, error } = await supabase
      .from("produtos")
      .select("id, categoria_id, slug, nome, descricao, ingredientes, preco, imagem_url, vegetariano, disponivel, ordem")
      .order("categoria_id")
      .order("ordem");
    if (error) return falha(res, error, "Não foi possível carregar os produtos.");
    res.json(data);
  });

  router.post("/produtos", async (req, res) => {
    try {
      const produto = await validarProduto(supabase, req.body);
      const slug = await gerarSlugUnico(supabase, produto.nome);

      const { data: ultimo } = await supabase
        .from("produtos")
        .select("ordem")
        .eq("categoria_id", produto.categoria_id)
        .order("ordem", { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data, error } = await supabase
        .from("produtos")
        .insert({ ...produto, slug, ordem: (ultimo?.ordem ?? 0) + 1 })
        .select()
        .single();
      if (error) throw error;

      avisarCardapioAlterado();
      res.status(201).json(data);
    } catch (erro) {
      tratarErro(res, erro, "Não foi possível cadastrar o produto.");
    }
  });

  router.put("/produtos/:id", async (req, res) => {
    try {
      const id = idValido(req.params.id);
      const { data: atual, error: erroBusca } = await supabase
        .from("produtos").select("id, imagem_url").eq("id", id).maybeSingle();
      if (erroBusca) throw erroBusca;
      if (!atual) return res.status(404).json({ erro: "Produto não encontrado." });

      const produto = await validarProduto(supabase, req.body);
      const { data, error } = await supabase
        .from("produtos").update(produto).eq("id", id).select().single();
      if (error) throw error;

      if (atual.imagem_url && atual.imagem_url !== produto.imagem_url) {
        await removerImagem(supabase, atual.imagem_url);
      }
      avisarCardapioAlterado();
      res.json(data);
    } catch (erro) {
      tratarErro(res, erro, "Não foi possível salvar o produto.");
    }
  });

  router.delete("/produtos/:id", async (req, res) => {
    try {
      const id = idValido(req.params.id);
      const { data, error } = await supabase
        .from("produtos").delete().eq("id", id).select("id, imagem_url").maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ erro: "Produto não encontrado." });

      if (data.imagem_url) await removerImagem(supabase, data.imagem_url);
      avisarCardapioAlterado();
      res.status(204).end();
    } catch (erro) {
      tratarErro(res, erro, "Não foi possível excluir o produto.");
    }
  });

  // Upload de imagem → Supabase Storage (bucket público "produtos")
  router.post("/imagens", async (req, res) => {
    try {
      const { tipo, base64 } = req.body ?? {};
      const extensao = TIPOS_IMAGEM[tipo];
      if (!extensao) throw new ErroValidacao("Use uma imagem JPG, PNG ou WEBP.");

      const arquivo = Buffer.from(typeof base64 === "string" ? base64 : "", "base64");
      if (!arquivo.length) throw new ErroValidacao("Imagem vazia.");
      if (arquivo.length > LIMITE_IMAGEM) throw new ErroValidacao("A imagem deve ter no máximo 5 MB.");

      await garantirBucket(supabase);
      const caminho = `${Date.now()}-${randomUUID()}.${extensao}`;
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(caminho, arquivo, { contentType: tipo, cacheControl: "31536000" });
      if (error) throw error;

      const { data } = supabase.storage.from(BUCKET).getPublicUrl(caminho);
      res.status(201).json({ url: data.publicUrl });
    } catch (erro) {
      tratarErro(res, erro, "Não foi possível enviar a imagem.");
    }
  });

  // -------------------------------------------------------------------
  // RF007 — Lista de pedidos
  // -------------------------------------------------------------------
  router.get("/pedidos", async (req, res) => {
    const status = req.query.status;
    if (status && !STATUS_ADMIN.includes(status)) {
      return res.status(400).json({ erro: "Status inválido." });
    }

    let consulta = supabase
      .from("pedidos")
      .select(
        `id, nome_cliente, mesa, observacoes, status, total, created_at,
         itens_pedido(id, nome_produto, quantidade, preco_unitario, observacao, subtotal,
           itens_pedido_opcoes(nome_opcao, preco_adicional))`,
      )
      .order("created_at", { ascending: false })
      .limit(100);
    if (status) consulta = consulta.eq("status", status);

    // Maior número de pedido existente — o painel usa para avisar pedidos novos
    const ultimo = supabase.from("pedidos").select("id").order("id", { ascending: false }).limit(1).maybeSingle();

    const [{ data, error }, { data: maisRecente, error: erroUltimo }] = await Promise.all([consulta, ultimo]);
    if (error || erroUltimo) return falha(res, error || erroUltimo, "Não foi possível carregar os pedidos.");

    res.json({
      ultimo_id: maisRecente?.id ?? 0,
      pedidos: data.map(({ itens_pedido, ...p }) => ({
        ...p,
        itens: (itens_pedido ?? [])
          .sort((a, b) => a.id - b.id)
          .map(({ itens_pedido_opcoes, ...item }) => ({ ...item, opcoes: itens_pedido_opcoes ?? [] })),
      })),
    });
  });

  // -------------------------------------------------------------------
  // RF008 — Atualizar status (com histórico)
  // -------------------------------------------------------------------
  router.patch("/pedidos/:id/status", async (req, res) => {
    try {
      const id = idValido(req.params.id);
      const novo = req.body?.status;
      if (!STATUS_ADMIN.includes(novo)) throw new ErroValidacao("Status inválido.");

      const { data: atual, error: erroBusca } = await supabase
        .from("pedidos").select("id, status").eq("id", id).maybeSingle();
      if (erroBusca) throw erroBusca;
      if (!atual) return res.status(404).json({ erro: "Pedido não encontrado." });
      if (atual.status === novo) return res.json({ id, status: novo });

      const { error: erroUpdate } = await supabase.from("pedidos").update({ status: novo }).eq("id", id);
      if (erroUpdate) throw erroUpdate;

      const { error: erroHistorico } = await supabase.from("historico_status").insert({
        pedido_id: id,
        status_anterior: atual.status,
        status_novo: novo,
        alterado_por: req.admin.id,
      });
      if (erroHistorico) console.error("Falha ao registrar histórico:", erroHistorico);

      res.json({ id, status: novo });
    } catch (erro) {
      tratarErro(res, erro, "Não foi possível atualizar o status.");
    }
  });

  router.get("/pedidos/:id/historico", async (req, res) => {
    try {
      const id = idValido(req.params.id);
      const { data, error } = await supabase
        .from("historico_status")
        .select("id, status_anterior, status_novo, alterado_em, administradores(nome)")
        .eq("pedido_id", id)
        .order("alterado_em");
      if (error) throw error;

      res.json(data.map(({ administradores, ...h }) => ({
        ...h,
        alterado_por: administradores?.nome ?? null,
      })));
    } catch (erro) {
      tratarErro(res, erro, "Não foi possível carregar o histórico.");
    }
  });

  // -------------------------------------------------------------------
  // Comandas — o cliente acumula pedidos; o admin fecha na hora de pagar
  // -------------------------------------------------------------------
  router.get("/comandas", async (req, res) => {
    const { data, error } = await supabase
      .from("comandas")
      .select("id, nome_cliente, mesa, status, created_at, pedidos(id, status, total)")
      .eq("status", "aberta")
      .order("created_at");
    if (error) return falha(res, error, "Não foi possível carregar as comandas.");

    res.json(data.map(({ pedidos, ...c }) => {
      const lista = (pedidos ?? [])
        .sort((a, b) => a.id - b.id)
        .map((p) => ({ ...p, total: Number(p.total) }));
      return { ...c, total: totalDaComanda(lista), pedidos: lista };
    }));
  });

  router.patch("/comandas/:id/fechar", async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
      return res.status(404).json({ erro: "Comanda não encontrada ou já fechada." });
    }
    const { data, error } = await supabase
      .from("comandas")
      .update({ status: "fechada", fechada_em: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("status", "aberta")
      .select("id")
      .maybeSingle();
    if (error) return falha(res, error, "Não foi possível fechar a comanda.");
    if (!data) return res.status(404).json({ erro: "Comanda não encontrada ou já fechada." });
    res.json({ id: data.id, status: "fechada" });
  });

  return router;
}

// ---------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------
async function buscarAdmin(supabase, userId) {
  const { data, error } = await supabase
    .from("administradores")
    .select("id, nome, email, ativo")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error("Erro ao buscar administrador:", error);
    return null;
  }
  return data?.ativo ? data : null;
}

function exigirAdmin(supabase) {
  return async (req, res, next) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return res.status(401).json({ erro: "Faça login para continuar." });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ erro: "Sessão expirada. Faça login novamente." });
    }

    const admin = await buscarAdmin(supabase, data.user.id);
    if (!admin) return res.status(403).json({ erro: "Esta conta não tem acesso ao painel." });

    req.admin = admin;
    next();
  };
}

// ---------------------------------------------------------------------
// Validação de produto (RF006)
// ---------------------------------------------------------------------
async function validarProduto(supabase, body) {
  const b = body ?? {};

  const nome = typeof b.nome === "string" ? b.nome.trim() : "";
  if (!nome) throw new ErroValidacao("O nome é obrigatório.");
  if (nome.length > 80) throw new ErroValidacao("O nome deve ter no máximo 80 caracteres.");

  const categoria_id = Number(b.categoria_id);
  if (!Number.isInteger(categoria_id) || categoria_id < 1) {
    throw new ErroValidacao("Escolha uma categoria.");
  }
  const { data: categoria } = await supabase
    .from("categorias").select("id").eq("id", categoria_id).maybeSingle();
  if (!categoria) throw new ErroValidacao("Categoria não encontrada.");

  if (b.preco === "" || b.preco === null || b.preco === undefined) {
    throw new ErroValidacao("O preço é obrigatório.");
  }
  const preco = Number(String(b.preco).replace(",", "."));
  if (!Number.isFinite(preco) || preco < 0 || preco > 9999) {
    throw new ErroValidacao("Preço inválido.");
  }

  const descricao = typeof b.descricao === "string" && b.descricao.trim() ? b.descricao.trim() : null;
  if (descricao && descricao.length > 400) {
    throw new ErroValidacao("A descrição deve ter no máximo 400 caracteres.");
  }

  const listaIngredientes = Array.isArray(b.ingredientes)
    ? b.ingredientes
    : typeof b.ingredientes === "string" ? b.ingredientes.split(",") : [];
  const ingredientes = listaIngredientes
    .map((i) => String(i).trim())
    .filter(Boolean)
    .slice(0, 30);

  const imagem_url = typeof b.imagem_url === "string" && b.imagem_url.trim() ? b.imagem_url.trim() : null;
  if (imagem_url && !/^https?:\/\//i.test(imagem_url)) {
    throw new ErroValidacao("Endereço de imagem inválido.");
  }

  return {
    nome,
    categoria_id,
    preco: Math.round(preco * 100) / 100,
    descricao,
    ingredientes: ingredientes.length ? ingredientes : null,
    imagem_url,
    vegetariano: Boolean(b.vegetariano),
    disponivel: b.disponivel === undefined ? true : Boolean(b.disponivel),
  };
}

async function gerarSlugUnico(supabase, nome) {
  const base =
    nome
      .normalize("NFD").replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "produto";

  const { data } = await supabase.from("produtos").select("slug").like("slug", `${base}%`);
  const usados = new Set((data ?? []).map((p) => p.slug));
  if (!usados.has(base)) return base;

  let n = 2;
  while (usados.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ---------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------
let bucketPronto = false;

async function garantirBucket(supabase) {
  if (bucketPronto) return;
  const { data } = await supabase.storage.getBucket(BUCKET);
  if (!data) {
    const { error } = await supabase.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: LIMITE_IMAGEM,
      allowedMimeTypes: Object.keys(TIPOS_IMAGEM),
    });
    if (error && !/exist/i.test(error.message)) throw error;
  }
  bucketPronto = true;
}

async function removerImagem(supabase, url) {
  const marcador = `/storage/v1/object/public/${BUCKET}/`;
  const posicao = url.indexOf(marcador);
  if (posicao === -1) return; // imagem externa, não é nossa
  const caminho = decodeURIComponent(url.slice(posicao + marcador.length));
  const { error } = await supabase.storage.from(BUCKET).remove([caminho]);
  if (error) console.error("Falha ao remover imagem antiga:", error);
}

// ---------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------
function idValido(valor) {
  const id = Number(valor);
  if (!Number.isInteger(id) || id < 1) throw new ErroValidacao("Identificador inválido.");
  return id;
}

function falha(res, erro, mensagem) {
  console.error(mensagem, erro);
  return res.status(500).json({ erro: mensagem });
}

function tratarErro(res, erro, mensagem) {
  if (erro instanceof ErroValidacao) return res.status(400).json({ erro: erro.message });
  return falha(res, erro, mensagem);
}
