# Liga CDF ⚽

Webapp (pensada para telemóvel) para gerir a liga semanal entre amigos com **pontuação individual**: as equipas mudam todas as semanas e cada jogador soma os pontos da equipa em que jogou.

- Vitória **3** pts · Empate **1** · Derrota **0** (configurável em *Gerir → Definições*)
- Desempate: vitórias, depois menos jogos
- Tabela com pódio, forma recente, sequências, % vitórias e MVPs
- Perfil de cada jogador com histórico e melhores parceiros de equipa
- Histórico de jornadas

## Como funciona

É um site estático (HTML/CSS/JS, sem build) com uma pequena função serverless no Vercel. Os dados ficam em [`data.json`](data.json) neste repositório.

- **Toda a gente** vê a classificação pelo link.
- **Admins** entram em *Gerir* com um **PIN**. A função [`api/save.js`](api/save.js) confirma o PIN e grava o `data.json` no GitHub com um token guardado no Vercel (nunca chega ao browser). Cada alteração fica como commit, por isso tudo pode ser revertido.
- Alterações só ao `data.json` não geram novo deploy (`vercel.json`); a app lê os dados diretamente do GitHub.

### Variáveis de ambiente no Vercel

| Nome | Valor |
|---|---|
| `ADMIN_PIN` | O PIN de admin (6 ou mais dígitos) |
| `GITHUB_TOKEN` | Token *fine-grained* só para este repo, com **Contents: Read and write** |

Sem estas variáveis (ou no GitHub Pages), a app usa o modo antigo: o admin cola o token diretamente em *Gerir*.

## Desenvolvimento

```sh
python3 -m http.server
# abrir http://localhost:8000
```
