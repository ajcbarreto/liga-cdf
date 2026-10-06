/* Liga CDF — liga semanal entre amigos com pontuação individual.
 * Os dados vivem em data.json no próprio repositório GitHub.
 * Leitura: pública (API do GitHub, com fallback para o ficheiro publicado no Pages).
 * Escrita: só o admin, com um token GitHub guardado neste dispositivo. */
(() => {
  'use strict';

  // ---------- Configuração do repositório ----------
  const FALLBACK = { owner: 'ajcbarreto', repo: 'liga-cdf', branch: 'main' };
  const REPO = (() => {
    const h = location.hostname;
    if (h.endsWith('.github.io')) {
      const seg = location.pathname.split('/').filter(Boolean)[0];
      return { owner: h.split('.')[0], repo: seg || FALLBACK.repo, branch: FALLBACK.branch };
    }
    return FALLBACK;
  })();
  const DATA_PATH = 'data.json';
  const TOKEN_KEY = 'ligacdf.token';
  const PIN_KEY = 'ligacdf.pin';

  const EMPTY = {
    settings: { name: 'Liga CDF', pointsWin: 3, pointsDraw: 1, pointsLoss: 0 },
    players: [],
    matches: []
  };

  // ---------- Estado ----------
  let data = structuredClone(EMPTY);
  let sha = null;
  let loaded = false;
  let loadError = null;
  let draft = null;     // jogo em edição
  let saving = false;

  const $view = document.getElementById('view');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} }
  };
  // No Vercel existe /api/save e o admin entra com PIN; no GitHub Pages usa token.
  let pinMode = false;
  const token = () => (pinMode ? null : store.get(TOKEN_KEY));
  const pin = () => (pinMode ? store.get(PIN_KEY) : null);
  const isAdmin = () => !!(pinMode ? pin() : token());
  const callApi = body => fetch('api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function detectPinMode() {
    try {
      const r = await callApi({ action: 'ping' });
      pinMode = r.ok && (await r.json()).pin === true;
    } catch { pinMode = false; }
  }

  // ---------- Utilitários ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 9);
  const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const fmtDate = iso => {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('pt-PT', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
  const playerById = id => data.players.find(p => p.id === id);
  const pname = id => playerById(id)?.name ?? '—';
  const COLORS = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#22d3ee', '#f87171', '#a3e635', '#e879f9', '#2dd4bf', '#facc15'];
  const colorFor = id => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
  const initials = n => n.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const avatar = (p, big) => `<div class="avatar${big ? ' big' : ''}" style="background:${colorFor(p.id)}">${esc(initials(p.name))}</div>`;

  function toast(msg, err) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast' + (err ? ' err' : '');
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2600);
  }

  const b64encode = str => {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const b64decode = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), c => c.charCodeAt(0)));

  function normalize(d) {
    const out = structuredClone(EMPTY);
    if (d && typeof d === 'object') {
      Object.assign(out.settings, d.settings || {});
      out.players = Array.isArray(d.players) ? d.players : [];
      out.matches = Array.isArray(d.matches) ? d.matches : [];
    }
    return out;
  }

  // ---------- GitHub ----------
  const apiUrl = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}/contents/${DATA_PATH}`;

  async function load() {
    const btn = document.getElementById('refresh');
    btn.classList.add('spin');
    loadError = null;
    try {
      const headers = { Accept: 'application/vnd.github+json' };
      if (token()) headers.Authorization = `Bearer ${token()}`;
      let ok = false;
      try {
        const r = await fetch(`${apiUrl}?ref=${REPO.branch}&t=${Date.now()}`, { headers, cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          sha = j.sha;
          data = normalize(JSON.parse(b64decode(j.content)));
          ok = true;
        } else if (r.status === 401 && token()) {
          toast('Token inválido ou expirado. Volta a entrar.', true);
        } else if (r.status === 404) {
          data = structuredClone(EMPTY); sha = null; ok = true;
        }
      } catch { /* sem rede para a API; tenta o ficheiro publicado */ }
      if (!ok) {
        const r = await fetch(`${DATA_PATH}?t=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) throw new Error('Não foi possível carregar os dados.');
        data = normalize(await r.json());
      }
      loaded = true;
    } catch (e) {
      loadError = e.message;
    } finally {
      btn.classList.remove('spin');
      render();
    }
  }

  // Aplica uma alteração e grava no GitHub. mutate recebe uma cópia dos dados.
  async function commit(mutate, message) {
    if (saving) return false;
    if (!isAdmin()) { toast('Entra como admin primeiro.', true); return false; }
    saving = true;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const next = structuredClone(data);
        mutate(next);
        const json = JSON.stringify(next, null, 2) + '\n';
        const msg = message || 'Atualizar dados da liga';
        let r;
        if (pinMode) {
          r = await callApi({ action: 'save', pin: pin(), content: json, sha, message: msg });
        } else {
          const body = { message: msg, content: b64encode(json), branch: REPO.branch };
          if (sha) body.sha = sha;
          r = await fetch(apiUrl, {
            method: 'PUT',
            headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
        }
        if (r.ok) {
          const j = await r.json();
          sha = pinMode ? j.sha : j.content.sha;
          data = next;
          return true;
        }
        if (pinMode && r.status === 401) { store.del(PIN_KEY); render(); throw new Error('PIN errado. Volta a entrar.'); }
        if ((r.status === 409 || r.status === 422) && attempt === 0) {
          // Alguém gravou entretanto: recarrega e volta a aplicar a alteração.
          await load();
          continue;
        }
        if (r.status === 401 || r.status === 403) throw new Error('Sem permissão. Verifica o token.');
        if (pinMode && r.status === 502) {
          const j = await r.json().catch(() => ({}));
          const why = { 401: 'token inválido ou expirado', 403: 'token sem permissão de escrita (Contents: Read and write)', 404: `token sem acesso ao repo ${j.repo || ''}` }[j.status] || `${j.status} ${j.detail || ''}`;
          throw new Error(`O GitHub recusou: ${why}. Corrige o GITHUB_TOKEN no Vercel e faz Redeploy.`);
        }
        throw new Error(`Erro ao gravar (${r.status}).`);
      }
      throw new Error('Conflito ao gravar. Tenta outra vez.');
    } catch (e) {
      toast(e.message, true);
      return false;
    } finally {
      saving = false;
    }
  }

  // ---------- Cálculo da classificação ----------
  function resultFor(m, side) {
    if (m.result === 'D') return 'D';
    return m.result === side ? 'W' : 'L';
  }

  function compute() {
    const s = data.settings;
    const pts = { W: +s.pointsWin, D: +s.pointsDraw, L: +s.pointsLoss };
    const stats = {};
    for (const p of data.players) {
      stats[p.id] = { id: p.id, name: p.name, games: 0, W: 0, D: 0, L: 0, pts: 0, mvp: 0, form: [], streak: 0, streakType: null, bestWin: 0, curWin: 0, partners: {}, history: [] };
    }
    const matches = sortedMatches().slice().reverse(); // cronológico
    matches.forEach((m, idx) => {
      for (const side of ['A', 'B']) {
        const team = side === 'A' ? m.teamA : m.teamB;
        const r = resultFor(m, side);
        for (const id of team) {
          const st = stats[id];
          if (!st) continue;
          st.games++; st[r]++; st.pts += pts[r];
          st.form.push(r);
          st.streak = st.streakType === r ? st.streak + 1 : 1;
          st.streakType = r;
          st.curWin = r === 'W' ? st.curWin + 1 : 0;
          st.bestWin = Math.max(st.bestWin, st.curWin);
          st.history.push({ m, side, r, round: idx + 1 });
          for (const mate of team) {
            if (mate === id) continue;
            const pp = st.partners[mate] ||= { games: 0, W: 0 };
            pp.games++; if (r === 'W') pp.W++;
          }
        }
      }
      if (m.mvp && stats[m.mvp]) stats[m.mvp].mvp++;
    });
    const table = Object.values(stats).filter(st => st.games > 0).sort((a, b) =>
      b.pts - a.pts || b.W - a.W || a.games - b.games || a.name.localeCompare(b.name, 'pt'));
    return { stats, table, rounds: matches.length };
  }

  const sortedMatches = () => data.matches.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.created || 0) - (a.created || 0));
  const roundNumber = m => {
    const chron = sortedMatches().reverse();
    return chron.findIndex(x => x.id === m.id) + 1;
  };

  // ---------- Vistas ----------
  const formDots = form => `<span class="form">${form.slice(-5).map(r => `<i class="dot ${r}"></i>`).join('')}</span>`;

  function viewTable() {
    const { table, stats, rounds } = compute();
    if (!table.length) return emptyState('🏆', 'Ainda não há jogos.', isAdmin() ? '<a class="btn" href="#/admin/jogo">Adicionar o primeiro jogo</a>' : 'Assim que houver resultados a tabela aparece aqui.');
    const medals = ['🥇', '🥈', '🥉'];
    const top = table.slice(0, 3);
    const order = top.length === 3 ? [1, 0, 2] : top.map((_, i) => i);
    const podium = top.length >= 2 ? `<div class="podium">${order.map(i => {
      const p = top[i];
      return `<a class="pod p${i + 1}" href="#/jogador/${p.id}"><div class="medal">${medals[i]}</div><div class="nm">${esc(p.name)}</div><div class="pts">${p.pts}</div><div class="small muted">pontos</div></a>`;
    }).join('')}</div>` : '';

    const all = Object.values(stats).filter(s => s.games);
    const streakLeader = all.filter(s => s.streakType === 'W').sort((a, b) => b.streak - a.streak)[0];
    const mvpLeader = all.filter(s => s.mvp).sort((a, b) => b.mvp - a.mvp)[0];
    const minGames = Math.max(1, Math.ceil(rounds / 3));
    const pctLeader = all.filter(s => s.games >= minGames).sort((a, b) => b.W / b.games - a.W / a.games || b.games - a.games)[0];
    const bestStreak = all.slice().sort((a, b) => b.bestWin - a.bestWin)[0];
    const hl = [
      streakLeader && streakLeader.streak >= 2 ? ['🔥 Em sequência', `${streakLeader.name} · ${streakLeader.streak}V`] : null,
      pctLeader ? ['🎯 Melhor % vitórias', `${pctLeader.name} · ${pct(pctLeader.W, pctLeader.games)}%`] : null,
      mvpLeader ? ['⭐ Mais MVPs', `${mvpLeader.name} · ${mvpLeader.mvp}`] : null,
      bestStreak && bestStreak.bestWin >= 2 ? ['📈 Maior sequência', `${bestStreak.name} · ${bestStreak.bestWin}V`] : null
    ].filter(Boolean);

    return `
      ${podium}
      ${hl.length ? `<div class="highlights">${hl.map(([k, v]) => `<div class="hl"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>` : ''}
      <div class="card table-wrap">
        <table class="table">
          <thead><tr><th>#</th><th>Jogador</th><th>J</th><th>V</th><th>E</th><th>D</th><th>Pts</th><th>Forma</th></tr></thead>
          <tbody>${table.map((p, i) => `
            <tr onclick="location.hash='#/jogador/${p.id}'">
              <td class="pos">${i + 1}</td><td class="name">${esc(p.name)}</td>
              <td>${p.games}</td><td>${p.W}</td><td>${p.D}</td><td>${p.L}</td>
              <td class="pts">${p.pts}</td><td>${formDots(p.form)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="small muted center">Vitória ${data.settings.pointsWin} pts · Empate ${data.settings.pointsDraw} · Derrota ${data.settings.pointsLoss}. Desempate: vitórias, depois menos jogos.</p>`;
  }

  function matchCard(m, opts = {}) {
    const team = (side, ids) => `
      <div class="team ${side} ${m.result === side ? 'won' : ''}">
        <div class="tname">${side === 'A' ? 'Equipa A' : 'Equipa B'}${m.result === side ? ' 🏆' : ''}</div>
        <ul>${ids.map(id => `<li>${esc(pname(id))}</li>`).join('')}</ul>
      </div>`;
    const center = m.result === 'D' ? '=' : 'vs';
    return `
      <div class="card">
        <div class="match-head">
          <div><div class="match-date">Jornada ${roundNumber(m)}</div><div class="small muted">${fmtDate(m.date)}</div></div>
          ${m.result === 'D' ? '<span class="badge D">Empate</span>' : ''}
          ${opts.admin ? `<a class="btn secondary small" href="#/admin/jogo/${m.id}">Editar</a>` : ''}
        </div>
        <div class="vs">${team('A', m.teamA)}<div class="score">${center}</div>${team('B', m.teamB)}</div>
        ${m.mvp ? `<div class="mvp">⭐ MVP: ${esc(pname(m.mvp))}</div>` : ''}
      </div>`;
  }

  function viewGames() {
    const ms = sortedMatches();
    if (!ms.length) return emptyState('📅', 'Ainda não há jogos registados.', isAdmin() ? '<a class="btn" href="#/admin/jogo">Adicionar jogo</a>' : '');
    return `<h2>Jogos</h2>${isAdmin() ? '<a class="btn block" href="#/admin/jogo" style="margin-bottom:12px">＋ Novo jogo</a>' : ''}${ms.map(m => matchCard(m, { admin: isAdmin() })).join('')}`;
  }

  function viewPlayers() {
    const { stats, table } = compute();
    if (!data.players.length) return emptyState('👥', 'Ainda não há jogadores.', isAdmin() ? '<a class="btn" href="#/admin">Adicionar jogadores</a>' : '');
    const rank = Object.fromEntries(table.map((p, i) => [p.id, i + 1]));
    const players = data.players.slice().sort((a, b) => (rank[a.id] || 999) - (rank[b.id] || 999) || a.name.localeCompare(b.name, 'pt'));
    return `<h2>Jogadores</h2><div class="card" style="padding:0">${players.map(p => {
      const s = stats[p.id];
      return `<a class="player-row" href="#/jogador/${p.id}">${avatar(p)}
        <div class="info"><div class="nm">${esc(p.name)}</div>
        <div class="small muted">${s.games ? `${rank[p.id]}º · ${s.pts} pts · ${s.games} jogos · ${pct(s.W, s.games)}% vitórias` : 'Sem jogos'}</div></div>
        <span class="chev">›</span></a>`;
    }).join('')}</div>`;
  }

  function viewPlayer(id) {
    const p = playerById(id);
    if (!p) return emptyState('🤷', 'Jogador não encontrado.', '<a class="btn secondary" href="#/jogadores">Voltar</a>');
    const { stats, table } = compute();
    const s = stats[id];
    const pos = table.findIndex(x => x.id === id) + 1;
    const partners = Object.entries(s.partners)
      .map(([pid, v]) => ({ pid, ...v, rate: v.W / v.games }))
      .sort((a, b) => b.rate - a.rate || b.games - a.games);
    const streakTxt = s.streakType ? `${s.streak}${s.streakType === 'W' ? 'V' : s.streakType === 'D' ? 'E' : 'D'}` : '—';
    const { rounds } = compute();
    return `
      <a href="#/jogadores" class="small muted" style="text-decoration:none">‹ Jogadores</a>
      <div class="profile-head" style="margin-top:10px">${avatar(p, true)}
        <div><div class="nm">${esc(p.name)}</div><div class="muted">${pos ? `${pos}º lugar` : 'Sem jogos'}</div></div>
      </div>
      <div class="stats">
        <div class="stat"><div class="v">${s.pts}</div><div class="k">Pontos</div></div>
        <div class="stat"><div class="v">${s.games}</div><div class="k">Jogos</div></div>
        <div class="stat"><div class="v">${pct(s.W, s.games)}%</div><div class="k">Vitórias</div></div>
        <div class="stat"><div class="v">${s.W}-${s.D}-${s.L}</div><div class="k">V-E-D</div></div>
        <div class="stat"><div class="v">${s.games ? (s.pts / s.games).toFixed(2) : '0'}</div><div class="k">Pts/jogo</div></div>
        <div class="stat"><div class="v">${streakTxt}</div><div class="k">Sequência</div></div>
        <div class="stat"><div class="v">${s.bestWin}</div><div class="k">Máx. vitórias</div></div>
        <div class="stat"><div class="v">${s.mvp}</div><div class="k">MVPs</div></div>
        <div class="stat"><div class="v">${pct(s.games, rounds)}%</div><div class="k">Presenças</div></div>
      </div>
      ${partners.length ? `<h3>Parceiros de equipa</h3><div class="card">${partners.slice(0, 6).map(x => `
        <div class="list-row"><span>${esc(pname(x.pid))}</span><span class="muted">${x.W}/${x.games} vitórias · <b style="color:var(--text)">${pct(x.W, x.games)}%</b></span></div>`).join('')}</div>` : ''}
      ${s.history.length ? `<h3>Histórico</h3><div class="card">${s.history.slice().reverse().map(h => {
        const m = h.m;
        return `<div class="list-row"><span><span class="badge ${h.r}">${h.r === 'W' ? 'V' : h.r === 'D' ? 'E' : 'D'}</span> &nbsp;Jornada ${h.round} <span class="muted small">· ${fmtDate(m.date)}</span></span><span class="muted">${m.mvp === id ? '⭐ MVP' : ''}</span></div>`;
      }).join('')}</div>` : ''}`;
  }

  // ---------- Admin ----------
  function viewLogin() {
    if (pinMode) return `
      <h2>Gerir a liga</h2>
      <div class="card">
        <p style="margin-top:0">Só o admin pode adicionar jogos. Introduz o PIN (fica guardado neste telemóvel).</p>
        <label class="fld" for="pin">PIN</label>
        <input id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="••••••">
        <div style="height:12px"></div>
        <button class="btn block" id="login">Entrar</button>
      </div>`;
    return `
      <h2>Gerir a liga</h2>
      <div class="card">
        <p style="margin-top:0">Só o admin pode adicionar jogos. Para entrar, cola aqui o teu token GitHub (fica guardado só neste telemóvel).</p>
        <label class="fld" for="tok">Token GitHub</label>
        <input id="tok" type="password" autocomplete="off" placeholder="github_pat_…">
        <div style="height:12px"></div>
        <button class="btn block" id="login">Entrar</button>
        <div class="help" style="margin-top:14px">
          <b>Como criar o token (uma vez):</b>
          <ol>
            <li>Abre <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a></li>
            <li>Nome: <code>liga-cdf</code>. Expiração: a que quiseres (ex.: 1 ano).</li>
            <li>Repository access: <b>Only select repositories</b> → <code>${esc(REPO.repo)}</code></li>
            <li>Permissions → Repository → <b>Contents: Read and write</b></li>
            <li>Gera, copia e cola aqui.</li>
          </ol>
        </div>
      </div>`;
  }

  function viewAdmin() {
    if (!isAdmin()) return viewLogin();
    const s = data.settings;
    const used = new Set(data.matches.flatMap(m => [...m.teamA, ...m.teamB]));
    return `
      <h2>Gerir a liga</h2>
      <a class="btn block" href="#/admin/jogo">＋ Novo jogo</a>

      <h3>Jogadores (${data.players.length})</h3>
      <div class="card">
        <div class="row"><input id="new-player" type="text" placeholder="Nome do jogador" maxlength="30"><button class="btn" id="add-player" style="flex:none">Adicionar</button></div>
        <div style="margin-top:10px">${data.players.slice().sort((a, b) => a.name.localeCompare(b.name, 'pt')).map(p => `
          <div class="inline-edit">
            <input type="text" value="${esc(p.name)}" data-rename="${p.id}" maxlength="30">
            ${used.has(p.id) ? '' : `<button class="btn danger small" data-del-player="${p.id}">Apagar</button>`}
          </div>`).join('') || '<p class="muted small">Ainda não há jogadores.</p>'}
        </div>
        <p class="small muted" style="margin-bottom:0">Para mudar um nome, edita e sai do campo. Só dá para apagar jogadores sem jogos.</p>
      </div>

      <h3>Definições</h3>
      <div class="card">
        <label class="fld" for="set-name">Nome da liga</label>
        <input id="set-name" type="text" value="${esc(s.name)}" maxlength="40">
        <div class="row">
          <div><label class="fld">Vitória</label><input id="set-w" type="number" value="${s.pointsWin}" inputmode="numeric"></div>
          <div><label class="fld">Empate</label><input id="set-d" type="number" value="${s.pointsDraw}" inputmode="numeric"></div>
          <div><label class="fld">Derrota</label><input id="set-l" type="number" value="${s.pointsLoss}" inputmode="numeric"></div>
        </div>
        <div style="height:12px"></div>
        <button class="btn secondary block" id="save-settings">Guardar definições</button>
      </div>

      <h3>Partilhar</h3>
      <div class="card">
        <p class="small muted" style="margin-top:0">Envia este link ao grupo. Toda a gente vê a tabela; só tu editas.</p>
        <button class="btn secondary block" id="share">Partilhar link</button>
      </div>

      <button class="btn danger block" id="logout" style="margin-top:8px">Sair deste dispositivo</button>`;
  }

  function newDraft(m) {
    return m
      ? { id: m.id, date: m.date, created: m.created, sides: Object.fromEntries([...m.teamA.map(i => [i, 'A']), ...m.teamB.map(i => [i, 'B'])]), result: m.result, mvp: m.mvp || '' }
      : { id: null, date: todayISO(), sides: {}, result: null, mvp: '' };
  }

  function viewMatchForm(id) {
    if (!isAdmin()) return viewLogin();
    if (!draft || draft.id !== (id || null)) {
      const m = id ? data.matches.find(x => x.id === id) : null;
      if (id && !m) return emptyState('🤷', 'Jogo não encontrado.', '<a class="btn secondary" href="#/jogos">Voltar</a>');
      draft = newDraft(m);
    }
    const d = draft;
    const players = data.players.slice().sort((a, b) => a.name.localeCompare(b.name, 'pt'));
    const inGame = players.filter(p => d.sides[p.id]);
    const countA = inGame.filter(p => d.sides[p.id] === 'A').length;
    const countB = inGame.length - countA;
    return `
      <a href="#/jogos" class="small muted" style="text-decoration:none">‹ Jogos</a>
      <h2 style="margin-top:8px">${d.id ? 'Editar jogo' : 'Novo jogo'}</h2>
      <div class="card">
        <label class="fld" for="m-date">Data</label>
        <input id="m-date" type="date" value="${esc(d.date)}">

        <label class="fld">Equipas · toca para escolher</label>
        <div class="chips">${players.map(p => `<button class="chip ${d.sides[p.id] || ''}" data-side="${p.id}">${esc(p.name)}</button>`).join('')}</div>
        <div class="legend"><span><i style="background:var(--a)"></i>A (${countA})</span><span><i style="background:var(--b)"></i>B (${countB})</span><span>1 toque = A · 2 = B · 3 = fora</span></div>
        <div class="row" style="margin-top:10px">
          <input id="quick-player" type="text" placeholder="Jogador novo…" maxlength="30">
          <button class="btn secondary" id="quick-add" style="flex:none">＋</button>
        </div>

        <label class="fld">Resultado</label>
        <div class="seg">
          <button class="A ${d.result === 'A' ? 'sel' : ''}" data-result="A">Ganhou A</button>
          <button class="D ${d.result === 'D' ? 'sel' : ''}" data-result="D">Empate</button>
          <button class="B ${d.result === 'B' ? 'sel' : ''}" data-result="B">Ganhou B</button>
        </div>

        <label class="fld" for="m-mvp">MVP (opcional)</label>
        <select id="m-mvp"><option value="">—</option>${inGame.map(p => `<option value="${p.id}" ${d.mvp === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>

        <div style="height:16px"></div>
        <button class="btn block" id="save-match">${d.id ? 'Guardar alterações' : 'Guardar jogo'}</button>
        ${d.id ? '<div style="height:8px"></div><button class="btn danger block" id="del-match">Apagar jogo</button>' : ''}
      </div>`;
  }

  function emptyState(icon, msg, extra) {
    return `<div class="empty"><div class="big">${icon}</div><p>${esc(msg)}</p>${extra || ''}</div>`;
  }

  // ---------- Router ----------
  function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    const parts = h.split('/').filter(Boolean);
    let tab = 'table', html;
    if (!loaded) {
      html = loadError ? emptyState('⚠️', loadError, '<button class="btn" onclick="location.reload()">Tentar outra vez</button>') : emptyState('⏳', 'A carregar…');
      tab = { jogos: 'games', jogadores: 'players', jogador: 'players', admin: 'admin' }[parts[0]] || 'table';
    } else if (parts[0] === 'jogos') { tab = 'games'; html = viewGames(); }
    else if (parts[0] === 'jogadores') { tab = 'players'; html = viewPlayers(); }
    else if (parts[0] === 'jogador') { tab = 'players'; html = viewPlayer(parts[1]); }
    else if (parts[0] === 'admin' && parts[1] === 'jogo') { tab = 'admin'; html = viewMatchForm(parts[2]); }
    else if (parts[0] === 'admin') { tab = 'admin'; html = viewAdmin(); }
    else html = viewTable();
    if (!(parts[0] === 'admin' && parts[1] === 'jogo')) draft = null;
    document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
    return html;
  }

  function render() {
    document.getElementById('league-name').textContent = data.settings.name || 'Liga CDF';
    document.title = data.settings.name || 'Liga CDF';
    const y = window.scrollY;
    $view.innerHTML = route();
    if (render.keepScroll) window.scrollTo(0, y); else window.scrollTo(0, 0);
    render.keepScroll = false;
  }
  const rerender = () => { render.keepScroll = true; render(); };

  // ---------- Eventos ----------
  function readDraftInputs() {
    if (!draft) return;
    const v = id => document.getElementById(id)?.value;
    draft.date = v('m-date') ?? draft.date;
    draft.mvp = v('m-mvp') ?? draft.mvp;
  }

  async function addPlayer(name) {
    name = name.trim().replace(/\s+/g, ' ');
    if (!name) return null;
    if (data.players.some(p => p.name.toLowerCase() === name.toLowerCase())) { toast('Esse jogador já existe.', true); return null; }
    const id = uid();
    const ok = await commit(d => d.players.push({ id, name }), `Adicionar jogador ${name}`);
    if (ok) toast(`${name} adicionado`);
    return ok ? id : null;
  }

  $view.addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;

    if (t.id === 'login' && pinMode) {
      const v = document.getElementById('pin').value.trim();
      if (!v) return;
      t.disabled = true;
      const r = await callApi({ action: 'check', pin: v }).catch(() => null);
      t.disabled = false;
      if (!r || !r.ok) return toast('PIN errado.', true);
      store.set(PIN_KEY, v);
      toast('Entraste como admin');
      return render();
    }
    if (t.id === 'login') {
      const v = document.getElementById('tok').value.trim();
      if (!v) return;
      t.disabled = true;
      const r = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}`, { headers: { Authorization: `Bearer ${v}`, Accept: 'application/vnd.github+json' } }).catch(() => null);
      const j = r && r.ok ? await r.json() : null;
      if (!j || !j.permissions?.push) {
        t.disabled = false;
        return toast('Token sem acesso de escrita a este repositório.', true);
      }
      store.set(TOKEN_KEY, v);
      toast('Entraste como admin');
      await load();
      return;
    }
    if (t.id === 'logout') { store.del(TOKEN_KEY); store.del(PIN_KEY); toast('Saíste'); return render(); }
    if (t.id === 'share') {
      const url = location.origin + location.pathname;
      if (navigator.share) navigator.share({ title: data.settings.name, url }).catch(() => {});
      else { navigator.clipboard?.writeText(url); toast('Link copiado'); }
      return;
    }
    if (t.id === 'add-player') {
      const inp = document.getElementById('new-player');
      t.disabled = true;
      if (await addPlayer(inp.value)) rerender();
      t.disabled = false;
      return;
    }
    if (t.dataset.delPlayer) {
      const p = playerById(t.dataset.delPlayer);
      if (!confirm(`Apagar ${p.name}?`)) return;
      if (await commit(d => { d.players = d.players.filter(x => x.id !== p.id); }, `Apagar jogador ${p.name}`)) { toast('Apagado'); rerender(); }
      return;
    }
    if (t.id === 'save-settings') {
      const n = document.getElementById('set-name').value.trim() || 'Liga CDF';
      const num = id => { const x = parseInt(document.getElementById(id).value, 10); return Number.isFinite(x) ? x : 0; };
      const w = num('set-w'), dr = num('set-d'), l = num('set-l');
      t.disabled = true;
      if (await commit(d => Object.assign(d.settings, { name: n, pointsWin: w, pointsDraw: dr, pointsLoss: l }), 'Atualizar definições')) { toast('Definições guardadas'); rerender(); }
      t.disabled = false;
      return;
    }

    // Formulário de jogo
    if (t.dataset.side) {
      readDraftInputs();
      const id = t.dataset.side;
      const cur = draft.sides[id];
      if (!cur) draft.sides[id] = 'A';
      else if (cur === 'A') draft.sides[id] = 'B';
      else { delete draft.sides[id]; if (draft.mvp === id) draft.mvp = ''; }
      return rerender();
    }
    if (t.dataset.result) { readDraftInputs(); draft.result = t.dataset.result; return rerender(); }
    if (t.id === 'quick-add') {
      readDraftInputs();
      const inp = document.getElementById('quick-player');
      t.disabled = true;
      const id = await addPlayer(inp.value);
      if (id) draft.sides[id] = 'A';
      t.disabled = false;
      return rerender();
    }
    if (t.id === 'save-match') {
      readDraftInputs();
      const d = draft;
      const teamA = Object.keys(d.sides).filter(k => d.sides[k] === 'A');
      const teamB = Object.keys(d.sides).filter(k => d.sides[k] === 'B');
      if (!d.date) return toast('Escolhe a data.', true);
      if (!teamA.length || !teamB.length) return toast('As duas equipas precisam de jogadores.', true);
      const result = d.result;
      if (!result) return toast('Indica quem ganhou.', true);
      const match = {
        id: d.id || uid(), date: d.date, created: d.created || Date.now(), teamA, teamB, result,
        ...(d.mvp && d.sides[d.mvp] ? { mvp: d.mvp } : {})
      };
      t.disabled = true;
      const ok = await commit(dd => {
        const i = dd.matches.findIndex(x => x.id === match.id);
        if (i >= 0) dd.matches[i] = match; else dd.matches.push(match);
      }, `${d.id ? 'Editar' : 'Adicionar'} jogo de ${match.date}`);
      t.disabled = false;
      if (ok) { draft = null; toast('Jogo guardado ✅'); location.hash = '#/'; }
      return;
    }
    if (t.id === 'del-match') {
      if (!confirm('Apagar este jogo? Os pontos são recalculados.')) return;
      const id = draft.id;
      if (await commit(dd => { dd.matches = dd.matches.filter(x => x.id !== id); }, 'Apagar jogo')) { draft = null; toast('Jogo apagado'); location.hash = '#/jogos'; }
    }
  });

  $view.addEventListener('change', async e => {
    const t = e.target;
    if (t.dataset.rename) {
      const name = t.value.trim().replace(/\s+/g, ' ');
      const p = playerById(t.dataset.rename);
      if (!name || name === p.name) { t.value = p.name; return; }
      if (await commit(d => { d.players.find(x => x.id === p.id).name = name; }, `Renomear ${p.name} para ${name}`)) toast('Nome atualizado');
      else t.value = p.name;
    }
  });

  $view.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const map = { 'new-player': 'add-player', 'quick-player': 'quick-add', tok: 'login', pin: 'login' };
    const b = map[e.target.id] && document.getElementById(map[e.target.id]);
    if (b) { e.preventDefault(); b.click(); }
  });

  window.addEventListener('hashchange', render);
  document.getElementById('refresh').addEventListener('click', () => load());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && loaded && !draft) load(); });

  render();
  detectPinMode().then(load);
})();
