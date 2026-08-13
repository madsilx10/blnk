const fs = require('fs');
const readline = require('readline');
const { ethers } = require('ethers');

const DOMAIN = 'blnkinc.xyz';
const URI = 'https://blnkinc.xyz';
const STATEMENT = 'Sign in with Ethereum to BLNK';
const CHAIN_ID = 1;

const PRIVATEKEY_FILE = 'privatekey.txt'; // satu private key per baris
const MIN_DELAY = 15000;
const MAX_DELAY = 30000;

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
async function cooldown(ms) {
  const totalSec = Math.ceil(ms / 1000);
  for (let s = totalSec; s > 0; s--) {
    process.stdout.write(`\r  cooldown ${s}s...   `);
    await sleep(1000);
  }
  process.stdout.write('\r                      \r');
}
function randomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
}

function readLines(path) {
  if (!fs.existsSync(path)) {
    console.error(`File ${path} tidak ditemukan.`);
    process.exit(1);
  }
  return fs.readFileSync(path, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
}

function extractCookieValue(setCookieHeader, name) {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function safeJson(res, label) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} - respons bukan JSON (status ${res.status}): ${text.slice(0, 150)}`);
  }
}

async function getNonce() {
  const res = await fetch(`https://${DOMAIN}/api/auth/nonce`, {
    headers: { ...COMMON_HEADERS, Referer: `https://${DOMAIN}/dashboard` },
  });
  const text = await res.text();
  if (!text || text.trim().startsWith('<')) {
    throw new Error(`getNonce - respons bukan nonce (status ${res.status}): ${text.slice(0, 150)}`);
  }
  return text.trim();
}

function buildSiweMessage({ address, nonce, issuedAt }) {
  return `${DOMAIN} wants you to sign in with your Ethereum account:
${address}

${STATEMENT}

URI: ${URI}
Version: 1
Chain ID: ${CHAIN_ID}
Nonce: ${nonce}
Issued At: ${issuedAt}`;
}

async function connectWallet(privateKey) {
  const wallet = new ethers.Wallet(privateKey);
  const nonce = await getNonce();
  const issuedAt = new Date().toISOString();

  const messageToSign = buildSiweMessage({ address: wallet.address, nonce, issuedAt });
  const signature = await wallet.signMessage(messageToSign);

  const res = await fetch(`https://${DOMAIN}/api/auth/verify`, {
    method: 'POST',
    headers: {
      ...COMMON_HEADERS,
      'Content-Type': 'application/json',
      Origin: `https://${DOMAIN}`,
      Referer: `https://${DOMAIN}/dashboard`,
    },
    body: JSON.stringify({
      message: {
        domain: DOMAIN,
        address: wallet.address,
        statement: STATEMENT,
        uri: URI,
        version: '1',
        chainId: CHAIN_ID,
        nonce,
        issuedAt,
      },
      signature,
    }),
  });

  const data = await safeJson(res, 'connectWallet');
  if (!data.ok) throw new Error(`gagal verify: ${JSON.stringify(data)}`);

  const setCookie = res.headers.get('set-cookie') || '';
  const sessionCookie = extractCookieValue(setCookie, 'blnk_siwe');

  return { address: wallet.address, sessionCookie };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}

async function selectAccounts(total) {
  console.log('\n1. 1 akun\n2. Semua akun\n3. From x to end\n');
  const mode = await ask('Pilihan (1/2/3): ');

  if (mode === '1') {
    const num = await ask(`Nomor akun (1-${total}): `);
    const idx = parseInt(num, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= total) { console.error('Nomor tidak valid.'); process.exit(1); }
    return [idx];
  }
  if (mode === '2') return Array.from({ length: total }, (_, i) => i);
  if (mode === '3') {
    const from = await ask(`Mulai dari nomor (1-${total}): `);
    const start = parseInt(from, 10) - 1;
    if (Number.isNaN(start) || start < 0 || start >= total) { console.error('Nomor tidak valid.'); process.exit(1); }
    return Array.from({ length: total - start }, (_, i) => start + i);
  }
  console.error('Pilihan tidak valid.');
  process.exit(1);
}

async function main() {
  const privateKeys = readLines(PRIVATEKEY_FILE);
  if (privateKeys.length === 0) { console.error('Tidak ada private key.'); return; }

  const indices = await selectAccounts(privateKeys.length);
  const selected = indices.map((idx) => ({ privateKey: privateKeys[idx], originalNum: idx + 1 }));

  for (let i = 0; i < selected.length; i++) {
    const { privateKey, originalNum } = selected[i];

    process.stdout.write(`[PROSES] akun ${originalNum} - connect wallet ... `);

    try {
      const { address } = await connectWallet(privateKey);
      console.log(`OK (${address})`);
    } catch (err) {
      console.log(`ERROR - ${err.message}`);
    }

    if (i !== selected.length - 1) await cooldown(randomDelay());
  }

  console.log('\nSelesai.');
}

main();
