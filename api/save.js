// Função serverless (Vercel): grava data.json no GitHub em nome do admin.
// Variáveis de ambiente no Vercel:
//   ADMIN_PIN     — PIN de admin (recomendado 6+ dígitos)
//   GITHUB_TOKEN  — token fine-grained com Contents: Read and write neste repo
//   GITHUB_REPO   — opcional, "dono/repo" (por defeito o repo ligado ao Vercel)
const crypto = require('crypto');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function pinOk(pin) {
  const expected = process.env.ADMIN_PIN || '';
  if (!expected || typeof pin !== 'string') return false;
  const a = crypto.createHash('sha256').update(pin).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function repo() {
  if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO;
  const o = process.env.VERCEL_GIT_REPO_OWNER, r = process.env.VERCEL_GIT_REPO_SLUG;
  return o && r ? `${o}/${r}` : 'ajcbarreto/liga-cdf';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Permite à app saber que o login por PIN está disponível.
  if (body.action === 'ping') return res.status(200).json({ pin: !!process.env.ADMIN_PIN && !!process.env.GITHUB_TOKEN });

  if (!pinOk(body.pin)) {
    await sleep(1500); // trava tentativas em série
    return res.status(401).json({ error: 'pin' });
  }
  if (body.action === 'check') return res.status(200).json({ ok: true });

  if (body.action !== 'save' || typeof body.content !== 'string') return res.status(400).json({ error: 'bad request' });
  try { JSON.parse(body.content); } catch { return res.status(400).json({ error: 'json' }); }

  const payload = {
    message: String(body.message || 'Atualizar dados da liga').slice(0, 200),
    content: Buffer.from(body.content, 'utf8').toString('base64'),
    branch: process.env.GITHUB_BRANCH || 'main'
  };
  if (body.sha) payload.sha = String(body.sha);

  const r = await fetch(`https://api.github.com/repos/${repo()}/contents/data.json`, {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'liga-cdf'
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) return res.status(r.status === 409 || r.status === 422 ? 409 : 502).json({ error: 'github', status: r.status });
  const j = await r.json();
  return res.status(200).json({ sha: j.content.sha });
};
