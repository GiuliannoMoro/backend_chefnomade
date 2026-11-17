// Avisos em tempo real para o site do cliente (Server-Sent Events).
// O site abre uma conexão em GET /api/eventos e o servidor envia
// "cardapio" sempre que o admin altera algum produto.

const clientes = new Set();

export function rotaEventos(req, res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // evita buffer em proxies (nginx)
  });
  res.flushHeaders();
  res.write("retry: 5000\n\n"); // navegador reconecta em 5s se cair

  clientes.add(res);
  req.on("close", () => clientes.delete(res));
}

export function avisarCardapioAlterado() {
  for (const res of clientes) res.write("event: cardapio\ndata: {}\n\n");
}

// Comentário periódico para a conexão não ser derrubada por inatividade
setInterval(() => {
  for (const res of clientes) res.write(": ping\n\n");
}, 25000).unref();
