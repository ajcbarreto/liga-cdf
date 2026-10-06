# Liga CDF ⚽

Webapp (pensada para telemóvel) para gerir a liga semanal entre amigos com **pontuação individual**: as equipas mudam todas as semanas e cada jogador soma os pontos da equipa em que jogou.

- Vitória **3** pts · Empate **1** · Derrota **0** (configurável em *Gerir → Definições*)
- Desempate: vitórias, diferença de golos, menos jogos
- Tabela com pódio, forma recente, sequências, % vitórias e MVPs
- Perfil de cada jogador com histórico e melhores parceiros de equipa
- Histórico de jornadas

## Como funciona

É um site estático (HTML/CSS/JS, sem build) publicado no GitHub Pages. Os dados ficam em [`data.json`](data.json) neste repositório.

- **Toda a gente** vê a classificação pelo link.
- **Só o admin** edita: em *Gerir*, cola um token GitHub *fine-grained* com acesso apenas a este repositório e permissão **Contents: Read and write**. O token fica guardado só nesse dispositivo e cada alteração vira um commit ao `data.json`.

## Desenvolvimento

```sh
python3 -m http.server
# abrir http://localhost:8000
```
