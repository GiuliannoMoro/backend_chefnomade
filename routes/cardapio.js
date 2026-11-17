import { Router } from "express";

// RF001 e RF002 — leitura do cardápio
export default function cardapioRoutes(supabase) {
  const router = Router();

  // GET /api/cardapio → categorias ativas com seus produtos disponíveis
  router.get("/cardapio", async (req, res) => {
    const { data, error } = await supabase
      .from("categorias")
      .select(
        "id, slug, nome, ordem, produtos(id, slug, nome, descricao, preco, imagem_url, vegetariano, disponivel, ordem)",
      )
      .eq("ativo", true)
      .order("ordem")
      .order("ordem", { referencedTable: "produtos" });

    if (error) {
      console.error("Erro ao buscar cardápio:", error);
      return res.status(500).json({ erro: "Não foi possível carregar o cardápio." });
    }

    const categorias = data.map((c) => ({
      id: c.id,
      slug: c.slug,
      nome: c.nome,
      produtos: (c.produtos ?? [])
        .filter((p) => p.disponivel)
        .map(({ disponivel, ordem, ...p }) => p),
    }));

    res.json(categorias);
  });

  // GET /api/produtos/:id → detalhe com ingredientes e grupos de opções
  router.get("/produtos/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ erro: "Produto inválido." });
    }

    const { data, error } = await supabase
      .from("produtos")
      .select(
        `id, slug, nome, descricao, ingredientes, preco, imagem_url, vegetariano, disponivel,
         categorias(slug, nome),
         produto_grupos(ordem, grupos_opcoes(id, slug, nome, min_escolhas, max_escolhas,
           opcoes(id, nome, preco_adicional, disponivel, ordem)))`,
      )
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error("Erro ao buscar produto:", error);
      return res.status(500).json({ erro: "Não foi possível carregar o produto." });
    }
    if (!data || !data.disponivel) {
      return res.status(404).json({ erro: "Produto não encontrado." });
    }

    const grupos = (data.produto_grupos ?? [])
      .filter((pg) => pg.grupos_opcoes)
      .sort((a, b) => a.ordem - b.ordem)
      .map(({ grupos_opcoes: g }) => ({
        id: g.id,
        slug: g.slug,
        nome: g.nome,
        min_escolhas: g.min_escolhas,
        max_escolhas: g.max_escolhas,
        opcoes: (g.opcoes ?? [])
          .filter((o) => o.disponivel)
          .sort((a, b) => a.ordem - b.ordem)
          .map(({ id, nome, preco_adicional }) => ({ id, nome, preco_adicional })),
      }));

    res.json({
      id: data.id,
      slug: data.slug,
      nome: data.nome,
      descricao: data.descricao,
      ingredientes: data.ingredientes ?? [],
      preco: data.preco,
      imagem_url: data.imagem_url,
      vegetariano: data.vegetariano,
      categoria: data.categorias,
      grupos,
    });
  });

  return router;
}
